import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type TokenUsage } from "@zhivex-ai/core";
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
  reserved_usd: number; price_status: string;
}
interface PolicyRow { policy: string }
const current = new AsyncLocalStorage<{ ledger: UsageLedger; runId: string }>();

/** A separate append-only transport ledger. SDK rollups are never added to these calls. */
export class UsageLedger {
  private constructor(private readonly database: SqliteDatabase, private readonly key: string,
    private readonly options: UsageAccountingOptions, private readonly now: () => number) {}

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
      price_status TEXT NOT NULL);`);
    return new UsageLedger(database, key, options, now);
  }

  close() { this.database.close(); }
  assertResume(runId: string) {
    const row = this.database.query<PolicyRow>("SELECT policy FROM zhivex_usage_policies WHERE scope_key = ?1 AND run_id = ?2").get(this.key, runId);
    if (!row) throw new Error("USAGE_LEDGER_MISSING: restore the complete state backup; a run snapshot cannot reset its monetary policy.");
  }
  private policy(runId: string): UsageAccountingOptions & { historicalUsageUnknown?: boolean } {
    const row = this.database.query<PolicyRow>("SELECT policy FROM zhivex_usage_policies WHERE scope_key = ?1 AND run_id = ?2").get(this.key, runId);
    return row ? JSON.parse(row.policy) as UsageAccountingOptions : this.options;
  }
  async run<T>(runId: string, operation: () => Promise<T>, historicalUsageUnknown = false): Promise<T> {
    this.database.query("INSERT OR IGNORE INTO zhivex_usage_policies (scope_key, run_id, policy) VALUES (?1, ?2, ?3)")
      .run(this.key, runId, JSON.stringify({ ...this.options, ...(historicalUsageUnknown ? { historicalUsageUnknown: true } : {}) }));
    this.database.query("UPDATE zhivex_usage_calls SET status = 'unknown' WHERE scope_key = ?1 AND run_id = ?2 AND status = 'pending'").run(this.key, runId);
    // Existing runs retain their original prices and cap even if the caller omits/changes flags.
    return current.run({ ledger: this, runId }, operation);
  }
  summary(runId: string) {
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
      historicalUsageUnknown: this.policy(runId).historicalUsageUnknown ?? false,
      usageComplete: !this.policy(runId).historicalUsageUnknown && rows.every(row => row.status === "confirmed"),
      estimatedUsd: this.policy(runId).historicalUsageUnknown || values.some(r => r.estimatedUsd === null) ? null : values.reduce((n, r) => n + (r.estimatedUsd ?? 0), 0),
      limitUsd: this.policy(runId).limitUsd ?? null,
      costKind: "estimate-not-invoice" as const };
  }
  private begin(runId: string, provider: string, model: string, input: Parameters<typeof estimateRequestTokens>[0]) {
    const policy = this.policy(runId);
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
      input.maxTokens = Math.min(input.maxTokens ?? 2048, 2048);
      reserved = (estimateRequestTokens(input) * usable.inputUsdPerMillion + input.maxTokens * usable.outputUsdPerMillion) / 1e6;
    }
    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (policy.requireCompleteUsage) {
        const unresolved = this.database.query<{ n: number }>("SELECT COUNT(*) AS n FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2 AND status = 'unknown'").get(this.key, runId);
        if (policy.historicalUsageUnknown || (unresolved?.n ?? 0) > 0) throw new Error("USAGE_UNCERTAIN: reconcile unknown utility usage before further execution.");
      }
      if (policy.limitUsd !== undefined) {
        const rows = this.database.query<CallRow>("SELECT * FROM zhivex_usage_calls WHERE scope_key = ?1 AND run_id = ?2").all(this.key, runId);
        if (rows.some(r => r.status === "unknown" || (r.status === "confirmed" && r.estimate_usd === null))) throw new Error("USAGE_UNCERTAIN: inspect unresolved calls before further monetary-budget execution.");
        const spent = rows.reduce((n, r) => n + (r.status === "pending" ? r.reserved_usd : r.estimate_usd ?? 0), 0);
        if (spent + reserved > policy.limitUsd) throw new Error("USAGE_COST_BUDGET: insufficient estimated budget for the next request.");
      }
      this.database.query(`INSERT INTO zhivex_usage_calls (id, scope_key, run_id, provider, model, status, reserved_usd, price_status)
        VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`).run(id, this.key, runId, provider, model, reserved, priceStatus);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return { id, price: usable };
  }
  private finish(call: ReturnType<UsageLedger["begin"]>, usage: TokenUsage | undefined) {
    const confirmed = usage && [usage.inputTokens, usage.outputTokens].every(v => Number.isSafeInteger(v) && v! >= 0);
    const estimate = confirmed && call.price
      ? (usage.inputTokens! * call.price.inputUsdPerMillion + usage.outputTokens! * call.price.outputUsdPerMillion) / 1e6 : null;
    // Compare-and-set prevents duplicate finish/error events from counting twice.
    this.database.query(`UPDATE zhivex_usage_calls SET status = ?1, input_tokens = ?2, output_tokens = ?3, estimate_usd = ?4
      WHERE id = ?5 AND status = 'pending'`).run(confirmed ? "confirmed" : "unknown",
        Number.isSafeInteger(usage?.inputTokens) && usage!.inputTokens! >= 0 ? usage!.inputTokens : null,
        Number.isSafeInteger(usage?.outputTokens) && usage!.outputTokens! >= 0 ? usage!.outputTokens : null, estimate, call.id);
  }
  model(model: LanguageModel): LanguageModel {
    const ledger = this;
    const middleware: LanguageModelMiddleware = {
      name: "harness-durable-usage-v1",
      async wrapGenerate(context, next) {
        const scope = current.getStore();
        if (!scope || scope.ledger !== ledger) throw new Error("Usage accounting requires a logical run scope.");
        const call = ledger.begin(scope.runId, model.provider, model.modelId, context.input);
        try { const result = await next(); ledger.finish(call, result.usage); return result; }
        catch (error) { ledger.finish(call, undefined); throw error; }
      },
      async wrapStream(context, next) {
        const scope = current.getStore();
        if (!scope || scope.ledger !== ledger) throw new Error("Usage accounting requires a logical run scope.");
        const call = ledger.begin(scope.runId, model.provider, model.modelId, context.input);
        try {
          const stream = await next();
          return (async function* () {
            try { for await (const event of stream) {
              if (event.type === "finish") ledger.finish(call, event.usage);
              yield event;
            } } finally { ledger.finish(call, undefined); }
          })();
        } catch (error) { ledger.finish(call, undefined); throw error; }
      }
    };
    return wrapLanguageModel(model, [middleware]);
  }
  store(store: AgentRunStore): AgentRunStore {
    const ledger = this;
    return new Proxy(store, { get(target, key) {
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
