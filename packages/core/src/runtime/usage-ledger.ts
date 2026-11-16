import { ProviderToolCallError } from "@zhivex-ai/core/provider";
import { taskUsageAdmission } from "./task-usage-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { fingerprintAgentHarness, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type TokenUsage } from "@zhivex-ai/core";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";
import { openCliSessionStore } from "../persistence/sessions.js";
import { SqliteDatabase } from "../persistence/sqlite-database.js";
import { estimateRequestTokens } from "./model-budget.js";
import type { HarnessConfig } from "./config.js";

export const USAGE_LEDGER_KEY = "zhivexUsageLedger";
const rate = z.number().finite().nonnegative();
export const usagePricingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  prices: z.array(z.strictObject({
    provider: z.string().min(1).max(128), model: z.string().min(1).max(512),
    inputUsdPerMillion: rate, outputUsdPerMillion: rate,
    source: z.string().min(1).max(1024),
    asOf: z.iso.datetime(), expiresAt: z.iso.datetime()
  })).max(100)
}).superRefine((value, ctx) => {
  const keys = new Set<string>();
  for (const price of value.prices) {
    const key = JSON.stringify([price.provider, price.model]);
    if (keys.has(key) || Date.parse(price.expiresAt) <= Date.parse(price.asOf)) {
      ctx.addIssue({ code: "custom", message: "Duplicate model price or invalid validity interval." });
    }
    keys.add(key);
  }
});
export type UsagePricing = z.infer<typeof usagePricingSchema>;
export interface UsageAccountingOptions { pricing?: UsagePricing; limitUsd?: number; requireCompleteUsage?: boolean }
const summaryView = z.object({ calls: z.number().int().nonnegative(), inputTokens: rate, outputTokens: rate,
  usageComplete: z.boolean(), estimatedUsd: rate.nullable(), limitUsd: rate.nullable() });
const ledgerView = summaryView.extend({ schemaVersion: z.literal(1), runId: z.string().max(256),
  historicalUsageUnknown: z.boolean().optional(), costKind: z.literal("estimate-not-invoice"),
  routes: z.array(z.object({ provider: z.string().max(128), model: z.string().max(512),
    calls: z.number().int().nonnegative(), inputTokens: rate, outputTokens: rate,
    unknownCalls: z.number().int().nonnegative(), estimatedUsd: rate.nullable(),
    priceStatuses: z.array(z.enum(["missing", "stale", "estimate"])) })).max(100)
});
export const inspectUsageLedger = (value: unknown) => {
  const parsed = ledgerView.safeParse(value);
  return parsed.success ? parsed.data : null;
};
export const formatUsageLedger = (value: unknown) => {
  const parsed = summaryView.safeParse(value);
  if (!parsed.success) return "Usage: unavailable for this run.";
  const v = parsed.data;
  return `Usage: ${v.calls} calls · ${v.inputTokens} input / ${v.outputTokens} output tokens${v.usageComplete ? "" : " · INCOMPLETE"}` +
    ` · estimated USD ${v.estimatedUsd === null ? "unknown" : v.estimatedUsd.toFixed(6)}${v.limitUsd === null ? "" : ` / ${v.limitUsd} limit`} (not an invoice)`;
};
interface CallRow {
  id: string; provider: string; model: string; status: string;
  input_tokens: number | null; output_tokens: number | null; estimate_usd: number | null;
  reserved_usd: number; price_status: string; category: string; late_receipt: number;
}
interface PolicyRow { policy: string }
const current = new AsyncLocalStorage<{ ledger: UsageLedger; runId: string; recovered: boolean }>();
const initialPolicies = new AsyncLocalStorage<{ ledger: UsageLedger; runId: string; policy: UsageAccountingOptions }>();

/** Internal task admission supplies its frozen policy without widening UsageLedger's public API. */
export const runUsageLedgerWithPolicy = <T>(ledger: UsageLedger, runId: string, operation: () => Promise<T>,
  historicalUsageUnknown = false, initialPolicy?: UsageAccountingOptions): Promise<T> => initialPolicy === undefined
  ? ledger.run(runId, operation, historicalUsageUnknown)
  : initialPolicies.run({ ledger, runId, policy: initialPolicy }, () => ledger.run(runId, operation, historicalUsageUnknown));

/** A separate append-only transport ledger. SDK rollups are never added to these calls. */
export class UsageLedger {
  private constructor(private readonly database: SqliteDatabase, private readonly key: string,
    private readonly options: UsageAccountingOptions, private readonly now: () => number) {
      taskReceiptViews.set(this, runId => this.database.query<{ id: string }>("SELECT id FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2").all(this.key, runId).map(row => fingerprintAgentHarness(row.id)));
      taskMonetaryViews.set(this, runId => {
        this.assertResume(runId);
        const policy = this.policy(runId);
        const rows = this.database.query<CallRow>("SELECT * FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2").all(this.key, runId);
        const confirmed = rows.filter(row => row.status === "confirmed");
        const pending = rows.filter(row => row.status === "pending");
        const unknown = rows.filter(row => row.status === "unknown");
        const sum = (values: CallRow[], field: "reserved_usd" | "estimate_usd") => values.some(row => row.price_status !== "estimate" || row[field] === null)
          ? null : values.reduce((total, row) => total + (row[field] ?? 0), 0);
        const estimatedConfirmedUsd = policy.historicalUsageUnknown ? null : sum(confirmed, "estimate_usd");
        const reservedUsd = sum(pending, "reserved_usd"), unknownHeldUsd = sum(unknown, "reserved_usd");
        const exposureKnown = estimatedConfirmedUsd !== null && reservedUsd !== null && unknownHeldUsd !== null;
        return { schemaVersion: 1 as const, confirmedCalls: confirmed.length, reservedCalls: pending.length, unknownCalls: unknown.length,
          lateCalls: rows.filter(row => row.late_receipt === 1).length, estimatedConfirmedUsd, reservedUsd, unknownHeldUsd,
          remainingUsd: policy.limitUsd === undefined || !exposureKnown ? null : Math.max(0, policy.limitUsd - estimatedConfirmedUsd! - reservedUsd! - unknownHeldUsd!),
          costComplete: !policy.historicalUsageUnknown && pending.length === 0 && unknown.length === 0 && estimatedConfirmedUsd !== null,
          categories: [...new Set(rows.map(row => row.category))], costKind: "estimate-not-invoice" as const };
      });
    }

  static async open(config: HarnessConfig, options: UsageAccountingOptions = {}, now = Date.now) {
    if (options.limitUsd !== undefined && (!Number.isFinite(options.limitUsd) || options.limitUsd <= 0)) throw new Error("Usage limit must be positive USD.");
    if (options.pricing) usagePricingSchema.parse(options.pricing);
    // Reuse the private, canonical, workspace/scope-bound SQLite initialization.
    const sessions = await openCliSessionStore({ workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope });
    const key = `${sessions.workspaceKey}:${sessions.scopeKey}`;
    const databasePath = sessions.databasePath;
    sessions.close();
    const before = await lstat(databasePath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("Usage database must be a regular private file.");
    const database = new SqliteDatabase(databasePath, { create: false, strict: true });
    const after = await lstat(databasePath);
    if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      database.close(); throw new Error("Usage database changed while opening.");
    }
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`CREATE TABLE IF NOT EXISTS zhivex_usage_policies (
      scope_key TEXT NOT NULL, run_id TEXT NOT NULL, policy TEXT NOT NULL,
      PRIMARY KEY (scope_key, run_id));
      CREATE TABLE IF NOT EXISTS zhivex_usage_calls (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, run_id TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, estimate_usd REAL, reserved_usd REAL NOT NULL,
      price_status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS zhivex_usage_calls_scope_run
      ON zhivex_usage_calls(scope_key, run_id);`);
    // Additive transport columns; retained legacy rows remain readable.
    database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(database.query<{ name: string }>("PRAGMA table_info(zhivex_usage_calls)").all().map(row => row.name));
      if (!columns.has("category")) database.exec("ALTER TABLE zhivex_usage_calls ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy'");
      if (!columns.has("late_receipt")) database.exec("ALTER TABLE zhivex_usage_calls ADD COLUMN late_receipt INTEGER NOT NULL DEFAULT 0");
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); database.close(); throw error; }
    return new UsageLedger(database, key, options, now);
  }

  close() { taskReceiptViews.delete(this); taskMonetaryViews.delete(this); this.database.close(); }
  assertResume(runId: string) {
    const row = this.database.query<PolicyRow>("SELECT policy FROM zhivex_usage_policies WHERE scope_key = ?1 AND run_id = ?2").get(this.key, runId);
    if (!row) throw new Error("USAGE_LEDGER_MISSING: retain or restore the complete operations SQLite database including transport usage tables; logical JSON exports cannot restore this monetary authority.");
  }
  private policy(runId: string): UsageAccountingOptions & { historicalUsageUnknown?: boolean } {
    const row = this.database.query<PolicyRow>("SELECT policy FROM zhivex_usage_policies WHERE scope_key = ?1 AND run_id = ?2").get(this.key, runId);
    return row ? JSON.parse(row.policy) as UsageAccountingOptions : this.options;
  }
  async run<T>(runId: string, operation: () => Promise<T>, historicalUsageUnknown = false): Promise<T> {
    const admitted = initialPolicies.getStore();
    const initialPolicy = admitted?.ledger === this && admitted.runId === runId ? admitted.policy : this.options;
    if (initialPolicy.limitUsd !== undefined && (!Number.isFinite(initialPolicy.limitUsd) || initialPolicy.limitUsd <= 0)) throw new Error("Usage limit must be positive USD.");
    if (initialPolicy.pricing) usagePricingSchema.parse(initialPolicy.pricing);
    this.database.query("INSERT OR IGNORE INTO zhivex_usage_policies (scope_key, run_id, policy) VALUES (?1, ?2, ?3)")
      .run(this.key, runId, JSON.stringify({ ...initialPolicy, ...(historicalUsageUnknown ? { historicalUsageUnknown: true } : {}) }));
    // Existing runs retain their original prices and cap even if the caller omits/changes flags.
    return current.run({ ledger: this, runId, recovered: false }, operation);
  }
  summary(runId: string) {
    const policy = this.policy(runId);
    const rows = this.database.query<CallRow>("SELECT * FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2 ORDER BY rowid").all(this.key, runId);
    const routes = new Map<string, { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; unknownCalls: number; estimatedUsd: number | null; priceStatuses: string[] }>();
    for (const row of rows) {
      const key = JSON.stringify([row.provider, row.model]);
      const entry = routes.get(key) ?? { provider: row.provider, model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, unknownCalls: 0, estimatedUsd: 0, priceStatuses: [] };
      entry.calls++;
      entry.inputTokens += row.input_tokens ?? 0; entry.outputTokens += row.output_tokens ?? 0;
      if (row.status !== "confirmed") entry.unknownCalls++;
      entry.estimatedUsd = entry.estimatedUsd === null || row.estimate_usd === null ? null : entry.estimatedUsd + row.estimate_usd;
      if (!entry.priceStatuses.includes(row.price_status)) entry.priceStatuses.push(row.price_status);
      routes.set(key, entry);
    }
    const values = [...routes.values()];
    return { schemaVersion: 1, runId, calls: rows.length, routes: values,
      inputTokens: values.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: values.reduce((n, r) => n + r.outputTokens, 0),
      historicalUsageUnknown: policy.historicalUsageUnknown ?? false,
      usageComplete: !policy.historicalUsageUnknown && rows.every(row => row.status === "confirmed"),
      estimatedUsd: policy.historicalUsageUnknown || values.some(r => r.estimatedUsd === null) ? null : values.reduce((n, r) => n + (r.estimatedUsd ?? 0), 0),
      limitUsd: policy.limitUsd ?? null,
      costKind: "estimate-not-invoice" as const };
  }
  private begin(runId: string, provider: string, model: string, input: Parameters<typeof estimateRequestTokens>[0]) {
    const policy = this.policy(runId);
    const task = taskUsageAdmission.getStore();
    // Token-cap and other outer host middleware may await after task admission.
    // This gate and the monetary reservation/provider handoff contain no await.
    task?.assertActive();
    if (task && task.accountRunId !== runId) throw new Error("TASK_BUDGET_MONETARY_OWNER_MISMATCH");
    const price = policy.pricing?.prices.find(p => p.provider === provider && p.model === model);
    const priceStatus = !price ? "missing" : Date.parse(price.asOf) > this.now() || Date.parse(price.expiresAt) <= this.now() ? "stale" : "estimate";
    const usable = priceStatus === "estimate" ? price : undefined;
    let reserved = 0;
    if (policy.limitUsd !== undefined) {
      if (policy.historicalUsageUnknown) throw new Error("USAGE_UNCERTAIN: historical usage predates the ledger.");
      if (!usable) throw new Error(`USAGE_PRICE_${priceStatus.toUpperCase()}: monetary limit cannot be calculated for ${provider}/${model}.`);
      // Fail closed on routes where this cap cannot be transmitted without changing API route.
      if (provider === "qwen" && input.providerOptions?.apiMode !== "chat" && input.maxTokens === undefined) {
        throw new Error("USAGE_OUTPUT_CAP_UNAVAILABLE: select a route with a supported output cap.");
      }
      input.maxTokens ??= 2048;
      if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) {
        throw new Error("USAGE_OUTPUT_CAP_INVALID: monetary reservations require a positive finite integer output cap.");
      }
      reserved = ((task?.inputCeiling ?? estimateRequestTokens(input)) * usable.inputUsdPerMillion + input.maxTokens * usable.outputUsdPerMillion) / 1e6;
    }
    if (task && policy.limitUsd === undefined && usable && input.maxTokens !== undefined) {
      reserved = (task.inputCeiling * usable.inputUsdPerMillion + input.maxTokens * usable.outputUsdPerMillion) / 1e6;
    }
    const id = task?.operationId ?? randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (policy.requireCompleteUsage || task) {
        const unresolved = this.database.query<{ n: number }>("SELECT COUNT(*) AS n FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2 AND status = 'unknown'").get(this.key, runId);
        if (policy.historicalUsageUnknown || (unresolved?.n ?? 0) > 0) throw new Error("USAGE_UNCERTAIN: reconcile unknown utility usage before further execution.");
      }
      if (policy.limitUsd !== undefined) {
        const rows = this.database.query<CallRow>("SELECT * FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2").all(this.key, runId);
        if (rows.some(r => r.status === "unknown" || (r.status === "confirmed" && r.estimate_usd === null))) throw new Error("USAGE_UNCERTAIN: inspect unresolved calls before further monetary-budget execution.");
        const spent = rows.reduce((n, r) => n + (r.status === "pending" ? r.reserved_usd : r.estimate_usd ?? 0), 0);
        const available = policy.limitUsd * (task && task.category !== "closure" ? 1 - task.closureReserve : 1);
        if (spent + reserved > available) throw new Error("USAGE_COST_BUDGET: insufficient estimated budget for the next request.");
      }
      this.database.query(`INSERT INTO zhivex_usage_calls (id, scope_key, run_id, provider, model, status, reserved_usd, price_status, category)
        VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)`).run(id, this.key, runId, provider, model, reserved, priceStatus, task?.category ?? "legacy");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return { id, price: usable, task: task !== undefined, signal: input.abortSignal };
  }
  private finish(call: ReturnType<UsageLedger["begin"]>, usage: TokenUsage | undefined) {
    const confirmed = usage && [usage.inputTokens, usage.outputTokens].every(v => Number.isSafeInteger(v) && v! >= 0);
    const estimate = confirmed && call.price
      ? (usage.inputTokens! * call.price.inputUsdPerMillion + usage.outputTokens! * call.price.outputUsdPerMillion) / 1e6 : null;
    // Compare-and-set prevents duplicate finish/error events from counting twice.
    this.database.query(`UPDATE zhivex_usage_calls SET status = ?1, input_tokens = ?2, output_tokens = ?3, estimate_usd = ?4,
      late_receipt = CASE WHEN ?6 = 1 AND ?8 = 1 AND (status = 'unknown' OR ?7 = 1) THEN 1 ELSE late_receipt END
      WHERE id = ?5 AND (status = 'pending' OR (?6 = 1 AND ?8 = 1 AND status = 'unknown'))`).run(confirmed ? "confirmed" : "unknown",
        Number.isSafeInteger(usage?.inputTokens) && usage!.inputTokens! >= 0 ? usage!.inputTokens : null,
        Number.isSafeInteger(usage?.outputTokens) && usage!.outputTokens! >= 0 ? usage!.outputTokens : null, estimate, call.id, call.task ? 1 : 0, call.signal?.aborted ? 1 : 0, confirmed ? 1 : 0);
  }
  model(model: LanguageModel): LanguageModel {
    const ledger = this;
    const middleware: LanguageModelMiddleware = {
      name: "harness-durable-usage-v1",
      async wrapGenerate(context, next) {
        const scope = current.getStore();
        if (!scope || scope.ledger !== ledger) throw new Error("Usage accounting requires a logical run scope.");
        let call: ReturnType<UsageLedger["begin"]>;
        try { call = ledger.begin(scope.runId, model.provider, model.modelId, context.input); }
        catch (error) { const task = taskUsageAdmission.getStore(); if (task) task.monetaryRefused = true; throw error; }
        try { const result = await next(); ledger.finish(call, result.usage); return result; }
        catch (error) { ledger.finish(call, call.task && error instanceof ProviderToolCallError && error.provider === model.provider && error.usageComplete ? error.usage : undefined); throw error; }
      },
      async wrapStream(context, next) {
        const scope = current.getStore();
        if (!scope || scope.ledger !== ledger) throw new Error("Usage accounting requires a logical run scope.");
        let call: ReturnType<UsageLedger["begin"]>;
        try { call = ledger.begin(scope.runId, model.provider, model.modelId, context.input); }
        catch (error) { const task = taskUsageAdmission.getStore(); if (task) task.monetaryRefused = true; throw error; }
        try {
          const stream = await next();
          return (async function* () {
            try { for await (const event of stream) {
              if (event.type === "finish") ledger.finish(call, event.usage);
              yield event;
            } } catch (error) {
              ledger.finish(call, call.task && error instanceof ProviderToolCallError && error.provider === model.provider && error.usageComplete ? error.usage : undefined);
              throw error;
            } finally { ledger.finish(call, undefined); }
          })();
        } catch (error) { ledger.finish(call, call.task && error instanceof ProviderToolCallError && error.provider === model.provider && error.usageComplete ? error.usage : undefined); throw error; }
      }
    };
    return wrapLanguageModel(model, [middleware]);
  }
  store(store: AgentRunStore): AgentRunStore {
    const ledger = this;
    return new Proxy(store, { get(target, key) {
      if (key === "acquireLease" && target.acquireLease) return async (...args: Parameters<NonNullable<AgentRunStore["acquireLease"]>>) => {
        const lease = await target.acquireLease!(...args);
        const scope = current.getStore();
        // Entering a run does not prove the prior worker has stopped. Recover
        // abandoned transports only after the durable store grants ownership.
        // Child leases and later approval continuations must not invalidate
        // transports already started by this logical invocation.
        if (lease && scope?.ledger === ledger && args[0] === scope.runId && !scope.recovered) {
          try {
            ledger.database.query("UPDATE zhivex_usage_calls SET status = 'unknown' WHERE scope_key = ?1 AND run_id = ?2 AND status = 'pending'")
              .run(ledger.key, scope.runId);
            scope.recovered = true;
          } catch (error) {
            await target.releaseLease?.(args[0], lease.ownerId, args[2]);
            throw error;
          }
        }
        return lease;
      };
      if (key === "save") return async (...args: Parameters<AgentRunStore["save"]>) => {
        const scope = current.getStore();
        if (scope?.ledger === ledger && args[0].runId === scope.runId) {
          args[0].metadata = { ...args[0].metadata, [USAGE_LEDGER_KEY]: ledger.summary(scope.runId) };
        }
        return target.save(...args);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}

const taskMonetaryViews = new WeakMap<UsageLedger, (runId: string) => {
  schemaVersion: 1; confirmedCalls: number; reservedCalls: number; unknownCalls: number; lateCalls: number;
  estimatedConfirmedUsd: number | null; reservedUsd: number | null; unknownHeldUsd: number | null;
  remainingUsd: number | null; costComplete: boolean; categories: string[]; costKind: "estimate-not-invoice";
}>();
export const inspectTaskMonetaryUsage = (ledger: UsageLedger, runId: string) => {
  const inspect = taskMonetaryViews.get(ledger);
  if (!inspect) throw new Error("USAGE_LEDGER_CLOSED");
  return inspect(runId);
};

const taskReceiptViews = new WeakMap<UsageLedger, (runId: string) => string[]>();
export const assertTaskMonetaryReceipts = (ledger: UsageLedger, runId: string, expected: readonly string[], allocations: readonly string[]) => {
  ledger.assertResume(runId);
  const view = taskReceiptViews.get(ledger);
  if (!view) throw new Error("USAGE_LEDGER_CLOSED");
  const actual = new Set(view(runId));
  if (expected.some(id => !actual.has(id))) throw new Error("TASK_BUDGET_MONETARY_RECEIPTS_MISSING: restore complete task accounting; a retained policy cannot replace missing transport receipts.");
  const retained = new Set(allocations);
  if ([...actual].some(id => !retained.has(id))) throw new Error("TASK_BUDGET_TOKEN_ALLOCATIONS_MISSING: restore complete task accounting; retained monetary receipts cannot replace missing token allocations.");
};
