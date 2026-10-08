import { taskUsageAdmission, type TaskUsageAdmission } from './task-usage-context.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAgentBudgetCoordinator, fingerprintAgentHarness, serializeJsonValue,
  type AgentRunState, type AgentStoreScope, type LanguageModelMiddleware, type TokenUsage, type ToolSet } from '@zhivex-ai/core';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import { ProviderToolCallError } from '@zhivex-ai/core/provider';
import { estimateRequestTokens } from './model-budget.js';
import { withRuntimeInstruction } from './runtime-instructions.js';
import { assertTaskMonetaryReceipts, usagePricingSchema, type UsageLedger, type UsageAccountingOptions } from './usage-ledger.js';

export const TASK_BUDGET_KEY = 'zhivexTaskBudgetV1';
export const TASK_BUDGET_ACCOUNT_KEY = 'zhivexTaskBudgetAccountV1';
const token = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokensSchema = z.strictObject({ inputTokens: token, outputTokens: token, totalTokens: token });
const policySchema = z.strictObject({ limits: tokensSchema, closureReserve: z.number().min(0).max(0.9),
  usageAccounting: z.strictObject({ pricing: usagePricingSchema.optional(), limitUsd: z.number().finite().positive().optional(),
    requireCompleteUsage: z.boolean().optional() }).optional() });
const cancellationSchema = z.strictObject({ runId: z.string().min(1).max(256), requestedAt: token,
  origin: z.enum(['operator', 'abort', 'timeout', 'lease_lost']), localToolsDrainedAt: token.optional() });
const accountSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), taskId: z.string().min(1).max(256),
  policy: policySchema, runs: z.array(z.string().min(1).max(256)).max(4096), admissionsClosed: z.boolean(),
  cancellations: z.array(cancellationSchema).max(4096).optional(),
  invocation: z.strictObject({ runId: z.string().min(1).max(256), ownerId: z.string().min(1).max(256) }).optional() });
// The metadata key remains stable for discovery; its payload version owns the
// Experimental format. Version 1 also reads the unpublished HU71 v0 snapshot.
function parseAccount(value: unknown) {
  const version = value && typeof value === 'object' ? Reflect.get(value, 'schemaVersion') : undefined;
  if (version !== 1 && version !== 2) throw new Error('TASK_BUDGET_ACCOUNT_VERSION_UNSUPPORTED: preserve the complete database and use a compatible task-account reader; do not remove control fields.');
  const parsed = accountSchema.safeParse(value);
  if (!parsed.success) throw new Error('TASK_BUDGET_ACCOUNT_INVALID: preserve the complete database; task-account control is not readable.');
  return parsed.data;
}
const allocationSchema = z.record(z.string(), z.strictObject({ status: z.enum(['reserved', 'confirmed', 'unknown']), tokens: tokensSchema }));
const summarySchema = z.strictObject({ schemaVersion: z.literal(1), taskId: z.string().min(1).max(256),
  accountRunId: z.string().min(1).max(256), revision: token, limits: tokensSchema, confirmed: tokensSchema,
  reserved: tokensSchema, unknown: tokensSchema, remaining: tokensSchema, usageComplete: z.boolean(),
  admissionsClosed: z.boolean(), invocationPending: z.boolean(), activeRunId: z.string().min(1).max(256).nullable(),
  runs: z.array(z.string().min(1).max(256)).max(4096), coordinatorId: z.string().min(1) });
export function inspectTaskBudgetSummary(value: unknown) {
  const parsed = summarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Portable snapshots must carry the original control identity/policy alongside every projection. */
export function assertTaskBudgetBackupLinks(states: readonly AgentRunState[]) {
  const byIdentity = new Map(states.map(state => [fingerprintAgentHarness({ scope: state.scope, runId: state.runId }), state]));
  for (const state of states) {
    const rawAccount = state.metadata?.[TASK_BUDGET_ACCOUNT_KEY];
    if (rawAccount !== undefined || state.runId.startsWith('task_budget_')) {
      const account = parseAccount(rawAccount);
      if (account.invocation) throw new Error('TASK_BUDGET_BACKUP_INVOCATION_PENDING');
      if (!state.scope || state.runId !== TaskBudget.accountId(state.scope, account.taskId) ||
        state.budgetCoordinatorId !== fingerprintAgentHarness({ budgetId: state.runId, scope: state.scope, limits: account.policy.limits }) ||
        new Set(account.runs).size !== account.runs.length) throw new Error('TASK_BUDGET_BACKUP_IDENTITY_MISMATCH');
    }
    const rawProjection = state.metadata?.[TASK_BUDGET_KEY];
    if (rawProjection === undefined) continue;
    const projection = summarySchema.parse(rawProjection);
    const root = byIdentity.get(fingerprintAgentHarness({ scope: state.scope, runId: projection.accountRunId }));
    if (!root) throw new Error('TASK_BUDGET_BACKUP_CONTROL_MISSING');
    const account = parseAccount(root.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
    if (account.taskId !== projection.taskId || root.budgetCoordinatorId !== projection.coordinatorId ||
        JSON.stringify(account.policy.limits) !== JSON.stringify(projection.limits) ||
        (!state.runId.startsWith('task_draft_') && !account.runs.includes(state.runId))) throw new Error('TASK_BUDGET_BACKUP_BINDING_MISMATCH');
  }
}
export interface TaskBudgetPolicy { limits: { inputTokens: number; outputTokens: number; totalTokens: number };
  closureReserve?: number; usageAccounting?: UsageAccountingOptions }
type Account = z.infer<typeof accountSchema>;
const active = new AsyncLocalStorage<{ account: TaskBudget; runId: string; ownerId: string; signal: AbortSignal;
  effects: Set<Promise<unknown>>; admissionsClosed: () => boolean }>();
// Store identity isolates independent SQLite authorities with equal scope/task IDs.
// The inner key is durable identity, never a TaskBudget object. A restarted host
// has no control handle and must retain an unresolved invocation.
const controls = new WeakMap<AgentRunStore, Map<string, () => Promise<void>>>();
const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const completeUsage = (usage?: TokenUsage): TokenUsage | undefined => {
  if (!usage || ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value! >= 0)) return undefined;
  const sum = usage.inputTokens! + usage.outputTokens!;
  if (!Number.isSafeInteger(sum) || (usage.totalTokens !== undefined && (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < sum))) return undefined;
  return { ...usage, totalTokens: usage.totalTokens ?? sum };
};

/** Task identity, exclusion and frozen policy; the SDK coordinator alone owns token allocations.
 * A transport admits one provider dispatch, retaining its full reservation on uncertain outcomes. */
export class TaskBudget {
  readonly accountRunId: string;
  readonly coordinatorId: string;
  readonly policy: TaskBudgetPolicy & { closureReserve: number };
  private writes: Promise<void> = Promise.resolve();
  private controlKey(runId: string) { return fingerprintAgentHarness({ scope: this.options.scope, taskId: this.options.taskId, runId }); }
  private readonly budgetRunId: string;
  private readonly budgetScope: AgentStoreScope;
  private readonly coordinator: ReturnType<typeof createAgentBudgetCoordinator>;
  private constructor(private readonly options: { store: AgentRunStore; scope: AgentStoreScope; taskId: string; now?: () => number }, account: Account) {
    const { store, scope, taskId } = options;
    this.accountRunId = TaskBudget.accountId(scope, taskId);
    this.policy = structuredClone(account.policy) as TaskBudgetPolicy & { closureReserve: number };
    const budgetId = this.accountRunId;
    this.coordinator = createAgentBudgetCoordinator({ store, scope, budgetId, limits: this.policy.limits });
    this.coordinatorId = this.coordinator.id;
    this.budgetRunId = `budget_${fingerprintAgentHarness({ budgetId, scope }).slice('sha256:'.length)}`;
    this.budgetScope = { tenantId: scope.tenantId, ...(scope.userId ? { userId: scope.userId } : {}), namespace: '__zhivex_budget__' };
  }
  static accountId(scope: AgentStoreScope, taskId: string) {
    return `task_budget_${fingerprintAgentHarness({ scope, taskId }).slice('sha256:'.length)}`;
  }
  static async open(options: { store: AgentRunStore; scope: AgentStoreScope; taskId: string; policy: TaskBudgetPolicy;
    requireExisting?: boolean; now?: () => number }): Promise<TaskBudget> {
    if (!options.store.acquireLease || !options.store.renewLease || !options.store.releaseLease) throw new Error('TASK_BUDGET_DURABLE_LEASE_REQUIRED');
    const id = this.accountId(options.scope, options.taskId);
    let state = await options.store.load(id, options.scope);
    if (!state) {
      if (options.requireExisting) throw new Error('TASK_BUDGET_MISSING: restore the full task account; historical consumption cannot be reset.');
      const account = parseAccount({ schemaVersion: 1, taskId: options.taskId, policy: { ...options.policy,
        closureReserve: options.policy.closureReserve ?? 0.3 }, runs: [], admissionsClosed: false });
      const candidate = new TaskBudget(options, account);
      const initial: AgentRunState = { schemaVersion: 1, runId: id, scope: options.scope, revision: 1,
        provider: 'zhivex', modelId: 'task-budget-account', status: 'completed', messages: [], steps: [], toolResults: [],
        pendingApprovals: [], currentStep: 0, maxSteps: 1, outputText: '', updatedAt: options.now?.() ?? Date.now(),
        budgetCoordinatorId: candidate.coordinatorId, metadata: { [TASK_BUDGET_ACCOUNT_KEY]: serializeJsonValue(account) } };
      try { await options.store.save(initial, { expectedRevision: 0 }); }
      catch (error) { state = await options.store.load(id, options.scope); if (!state) throw error; }
      state ??= initial;
    }
    const account = parseAccount(state.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
    if (account.taskId !== options.taskId || state.runId !== id) throw new Error('TASK_BUDGET_IDENTITY_MISMATCH');
    const instance = new TaskBudget(options, account);
    if (state.budgetCoordinatorId !== instance.coordinatorId) throw new Error('TASK_BUDGET_POLICY_MISMATCH');
    // Existing accounts are readable while their writer owns the task lease.
    // This path must never initialize a missing ledger or change admission state.
    if (options.requireExisting) {
      await instance.summary();
      return instance;
    }
    // Even an empty account owns a real SDK ledger, so portable backups cannot omit it.
    const ownerId = randomUUID();
    const lease = await options.store.acquireLease(id, { ownerId, ttlMs: 30_000, now: instance.now() }, options.scope);
    if (!lease) throw new Error('TASK_BUDGET_ACTIVE');
    try {
      if (!await options.store.load(instance.budgetRunId, instance.budgetScope)) {
        if (account.runs.length || options.requireExisting) throw new Error('TASK_BUDGET_LEDGER_MISSING');
        await instance.coordinator.reserve('task-account-initialization', zero);
        await instance.coordinator.settle('task-account-initialization', zero);
      }
      await instance.summary();
    } finally { await options.store.releaseLease(id, ownerId, options.scope); }
    return instance;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private async state() {
    const state = await this.options.store.load(this.accountRunId, this.options.scope);
    if (!state || state.budgetCoordinatorId !== this.coordinatorId) throw new Error('TASK_BUDGET_MISSING');
    const account = parseAccount(state.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
    if (account.taskId !== this.options.taskId || JSON.stringify(account.policy) !== JSON.stringify(this.policy)) throw new Error('TASK_BUDGET_POLICY_MISMATCH');
    return { state, account };
  }
  async summary() {
    const { state, account } = await this.state();
    const ledger = await this.options.store.load(this.budgetRunId, this.budgetScope);
    if (!ledger || ledger.metadata?.budgetIdentity !== this.coordinatorId) throw new Error('TASK_BUDGET_LEDGER_MISSING');
    const allocations = Object.values(allocationSchema.parse(ledger.metadata.allocations));
    const confirmed = { ...zero }, reserved = { ...zero }, unknown = { ...zero };
    for (const entry of allocations) {
      const target = entry.status === 'confirmed' ? confirmed : entry.status === 'reserved' ? reserved : unknown;
      for (const dimension of ['inputTokens', 'outputTokens', 'totalTokens'] as const) target[dimension] += entry.tokens[dimension];
    }
    const remaining = { ...zero };
    for (const dimension of ['inputTokens', 'outputTokens', 'totalTokens'] as const) remaining[dimension] =
      Math.max(0, this.policy.limits[dimension] - confirmed[dimension] - reserved[dimension] - unknown[dimension]);
    return { schemaVersion: 1 as const, taskId: account.taskId, accountRunId: this.accountRunId, revision: state.revision ?? 0,
      limits: structuredClone(this.policy.limits), confirmed, reserved, unknown, remaining,
      usageComplete: allocations.every(entry => entry.status === 'confirmed'), admissionsClosed: account.admissionsClosed,
      invocationPending: account.invocation !== undefined, activeRunId: account.invocation?.runId ?? null,
      runs: [...account.runs], coordinatorId: this.coordinatorId };
  }
  async assertMonetaryReceipts(ledger: UsageLedger) {
    const stored = await this.options.store.load(this.budgetRunId, this.budgetScope);
    if (!stored || stored.metadata?.budgetIdentity !== this.coordinatorId) throw new Error('TASK_BUDGET_LEDGER_MISSING');
    const allocations = allocationSchema.parse(stored.metadata.allocations);
    // Zero allocations include initialization and proven pre-dispatch refusals.
    const expected = Object.entries(allocations).filter(([, entry]) => Object.values(entry.tokens).some(value => value > 0)).map(([id]) => id);
    assertTaskMonetaryReceipts(ledger, this.accountRunId, expected, Object.keys(allocations));
  }
  private update(ownerId: string, mutate: (account: Account) => void, expectedRevision?: number): Promise<void> {
    const write = this.writes.then(async () => {
      if (!await this.options.store.renewLease!(this.accountRunId, { ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope)) throw new Error('TASK_BUDGET_LEASE_LOST');
      const { state, account } = await this.state();
      if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error('TASK_BUDGET_REVISION_CONFLICT');
      mutate(account);
      if (account.cancellations?.length) account.schemaVersion = 2;
      parseAccount(account);
      await this.options.store.save({ ...state, revision: (state.revision ?? 0) + 1, updatedAt: this.now(),
        metadata: { ...state.metadata, [TASK_BUDGET_ACCOUNT_KEY]: serializeJsonValue(account) } },
        { expectedRevision: state.revision ?? 0, leaseOwnerId: ownerId });
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async cancellations() {
    const { account } = await this.state();
    return (account.cancellations ?? []).map(entry => ({ ...entry,
      localExecution: entry.localToolsDrainedAt === undefined ? 'unconfirmed' as const : 'native_tools_drained' as const,
      remoteExecution: 'unconfirmed' as const }));
  }
  /** Acknowledges durable intent, not provider termination or rollback. */
  async requestCancellation(runId: string): Promise<void> {
    const control = controls.get(this.options.store)?.get(this.controlKey(runId));
    if (control) return control();
    const ownerId = randomUUID();
    if (!await this.options.store.acquireLease!(this.accountRunId, { ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope)) throw new Error('TASK_BUDGET_ACTIVE: cancellation requires the owning host');
    try {
      if (!(await this.state()).account.runs.includes(runId)) throw new Error('TASK_BUDGET_RUN_BINDING_MISSING');
      const run = await this.options.store.load(runId, this.options.scope);
      if (run && ['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status)) return;
      await this.update(ownerId, account => {
        if (account.invocation) throw new Error('TASK_BUDGET_INVOCATION_UNCERTAIN');
        if (!account.runs.includes(runId)) throw new Error('TASK_BUDGET_RUN_BINDING_MISSING');
        if (account.runs.at(-1) !== runId) throw new Error('TASK_BUDGET_STALE_RUN');
        // Repeating an old request cannot close a later explicit continuation.
        if (account.cancellations?.some(entry => entry.runId === runId)) return;
        account.admissionsClosed = true;
        (account.cancellations ??= []).push({ runId, requestedAt: this.now(), origin: 'operator' });
      });
    } finally { await this.options.store.releaseLease!(this.accountRunId, ownerId, this.options.scope); }
  }
  private assertLocalAdmission() {
    const invocation = active.getStore();
    if (!invocation || invocation.account !== this) throw new Error('TASK_BUDGET_SCOPE_REQUIRED');
    invocation.signal.throwIfAborted();
    if (invocation.admissionsClosed()) throw new Error('TASK_BUDGET_CANCELLED');
  }
  /** Recheck the task lease immediately before each admitted local action/checkpoint. */
  async assertOwnership(options: { allowCancelled?: boolean } = {}) {
    const invocation = active.getStore();
    if (!invocation || invocation.account !== this) throw new Error('TASK_BUDGET_SCOPE_REQUIRED');
    if (!options.allowCancelled) { invocation.signal.throwIfAborted(); if (invocation.admissionsClosed()) throw new Error('TASK_BUDGET_CANCELLED'); }
    if (!await this.options.store.renewLease!(this.accountRunId,
      { ownerId: invocation.ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope)) throw new Error('TASK_BUDGET_LEASE_LOST');
    const { account } = await this.state();
    if (account.invocation?.ownerId !== invocation.ownerId || account.invocation.runId !== invocation.runId) throw new Error('TASK_BUDGET_INVOCATION_OWNERSHIP_LOST');
    if (!options.allowCancelled) {
      invocation.signal.throwIfAborted();
      if (account.admissionsClosed || invocation.admissionsClosed()) throw new Error('TASK_BUDGET_CANCELLED');
    }
  }
  wrapTools(tools: ToolSet): ToolSet {
    return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
      if (!('execute' in tool) || !tool.execute) return [name, tool];
      const execute = tool.execute;
      return [name, { ...tool, execute: async (...args: Parameters<typeof execute>) => {
        const invocation = active.getStore();
        if (!invocation || invocation.account !== this) throw new Error('TASK_BUDGET_SCOPE_REQUIRED');
        // Track the complete action before its first asynchronous guard, including
        // callbacks the SDK may stop awaiting after cooperative cancellation.
        const effect = Promise.resolve().then(async () => {
          await this.assertOwnership();
          this.assertLocalAdmission();
          return execute(...args);
        });
        invocation.effects.add(effect);
        effect.then(() => invocation.effects.delete(effect), () => invocation.effects.delete(effect));
        return effect;
      } }];
    }));
  }
  /** A new explicit continuation may reopen known consumption. Late approvals never invoke this. */
  async reopen(expectedRevision: number) {
    const ownerId = randomUUID();
    const lease = await this.options.store.acquireLease!(this.accountRunId, { ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope);
    if (!lease) throw new Error('TASK_BUDGET_ACTIVE');
    try {
      const summary = await this.summary();
      if (summary.invocationPending) throw new Error('TASK_BUDGET_INVOCATION_UNCERTAIN');
      if (!summary.usageComplete) throw new Error('TASK_BUDGET_UNCERTAIN');
      await this.update(ownerId, account => { account.admissionsClosed = false; }, expectedRevision);
    } finally { await this.options.store.releaseLease!(this.accountRunId, ownerId, this.options.scope); }
  }
  async run<T>(runId: string, operation: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (active.getStore()) throw new Error('TASK_BUDGET_NESTED_INVOCATION');
    const ownerId = randomUUID();
    const lease = await this.options.store.acquireLease!(this.accountRunId, { ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope);
    if (!lease) throw new Error('TASK_BUDGET_ACTIVE');
    const lost = new AbortController(), requested = new AbortController();
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), lost.signal, requested.signal]);
    let renewal: Promise<void> | undefined, cancellation: Promise<void> | undefined;
    let registered = false, closing = false, toolsDrained = false;
    const close = (origin: z.infer<typeof cancellationSchema>['origin']) => {
      closing = true;
      cancellation ??= this.update(ownerId, account => {
        if ((account.invocation && (account.invocation.ownerId !== ownerId || account.invocation.runId !== runId)) || account.runs.at(-1) !== runId) throw new Error('TASK_BUDGET_INVOCATION_OWNERSHIP_LOST');
        account.admissionsClosed = true;
        if (!account.cancellations?.some(entry => entry.runId === runId))
          (account.cancellations ??= []).push({ runId, requestedAt: this.now(), origin, ...(toolsDrained ? { localToolsDrainedAt: this.now() } : {}) });
      });
      cancellation.catch(() => {});
      return cancellation;
    };
    const onAbort = () => { void close(lost.signal.aborted ? 'lease_lost' : signal.reason?.name === 'TimeoutError' ? 'timeout' : 'abort'); };
    const control = async () => {
      // Synchronous local barrier precedes persistence. Abort/ack follows it.
      await close('operator');
      requested.abort();
    };
    const renew = async () => {
      if (!await this.options.store.renewLease!(this.accountRunId, { ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope)) throw new Error('TASK_BUDGET_LEASE_LOST');
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const summary = await this.summary();
      if (summary.invocationPending) throw new Error('TASK_BUDGET_INVOCATION_UNCERTAIN');
      if (summary.admissionsClosed) throw new Error('TASK_BUDGET_CANCELLED');
      if (!summary.usageComplete) throw new Error('TASK_BUDGET_UNCERTAIN');
      signal.throwIfAborted();
      const prior = await this.options.store.load(runId, this.options.scope);
      const priorBinding = prior?.metadata?.[TASK_BUDGET_KEY] as Record<string, unknown> | undefined;
      if (prior && (!priorBinding || priorBinding.accountRunId !== this.accountRunId || priorBinding.taskId !== this.options.taskId)) throw new Error('TASK_BUDGET_RUN_BINDING_MISSING');
      const registry = controls.get(this.options.store) ?? new Map<string, () => Promise<void>>();
      controls.set(this.options.store, registry);
      registry.set(this.controlKey(runId), control);
      registered = true;
      // Queue the claim before registering the listener: close shares this write
      // queue, so an abort during save cannot race or erase the invocation.
      const claim = this.update(ownerId, account => {
        if (account.invocation) throw new Error('TASK_BUDGET_INVOCATION_UNCERTAIN');
        if (!account.runs.includes(runId)) account.runs.push(runId);
        account.invocation = { runId, ownerId };
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      await claim;
      await cancellation;
      timer = setInterval(() => { if (!renewal) renewal = renew().catch(error => { lost.abort(error); }).finally(() => { renewal = undefined; }); }, 10_000);
      timer.unref?.();
      const effects = new Set<Promise<unknown>>();
      const drain = async () => { while (effects.size) await Promise.allSettled([...effects]); };
      return await active.run({ account: this, runId, ownerId, signal, effects, admissionsClosed: () => closing }, async () => {
        try {
          signal.throwIfAborted();
          if (closing) throw new Error('TASK_BUDGET_CANCELLED');
          const result = await operation(signal);
          await drain();
          await this.assertOwnership();
          return result;
        } finally {
          await drain();
          toolsDrained = true;
          await renewal; await cancellation;
          // An expired worker cannot prove that every effect has ended for the
          // new owner. Keep the durable marker until explicit reconciliation.
          await this.assertOwnership({ allowCancelled: true });
          await this.update(ownerId, account => {
            if (account.invocation?.ownerId !== ownerId) throw new Error('TASK_BUDGET_INVOCATION_OWNERSHIP_LOST');
            const record = account.cancellations?.find(entry => entry.runId === runId);
            if (record) record.localToolsDrainedAt = this.now();
            delete account.invocation;
          });
        }
      });
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      if (registered) controls.get(this.options.store)?.delete(this.controlKey(runId));
      try { await renewal; await cancellation; }
      finally { await this.options.store.releaseLease!(this.accountRunId, ownerId, this.options.scope); }
    }
  }
  middleware(options: { closure?: () => boolean; auxiliary?: boolean; closeOnBudget?: boolean } = {}): LanguageModelMiddleware {
    const account = this;
    const begin = async (context: Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]) => {
      const invocation = active.getStore();
      if (!invocation || invocation.account !== account) throw new Error('TASK_BUDGET_SCOPE_REQUIRED');
      await account.assertOwnership();
      const summary = await account.summary();
      if (summary.admissionsClosed) throw new Error('TASK_BUDGET_CANCELLED');
      if (!summary.usageComplete) throw new Error('TASK_BUDGET_UNCERTAIN');
      const input = context.input;
      if (context.model.provider === 'qwen' && input.providerOptions?.apiMode !== 'chat') throw new Error('TASK_BUDGET_OUTPUT_CAP_UNAVAILABLE');
      let closure = options.closure?.() ?? false;
      let toolsDenied = false;
      const ceiling = { ...summary.remaining };
      const setCeiling = () => { for (const dimension of ['inputTokens', 'outputTokens', 'totalTokens'] as const) ceiling[dimension] = Math.max(0, summary.remaining[dimension] -
        (closure ? 0 : Math.ceil(account.policy.limits[dimension] * account.policy.closureReserve))); };
      setCeiling();
      let predicted = estimateRequestTokens(input);
      if (!closure && !options.auxiliary && options.closeOnBudget &&
          (predicted > ceiling.inputTokens || predicted >= ceiling.totalTokens || ceiling.outputTokens <= 0)) {
        closure = true;
        toolsDenied = true;
        delete input.tools; delete input.toolChoice;
        input.messages = withRuntimeInstruction(input.messages,
          'The task has reached its cumulative work budget. Finish using only evidence already collected; report remaining blockers and unverified work. No further tool execution is admitted.');
        predicted = estimateRequestTokens(input);
        setCeiling();
      }
      const requested = input.maxTokens;
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) throw new Error('TASK_BUDGET_INVALID_OUTPUT_CAP');
      if (!Number.isSafeInteger(predicted) || predicted > ceiling.inputTokens || predicted >= ceiling.totalTokens || ceiling.outputTokens <= 0) throw new Error('TASK_BUDGET_EXHAUSTED');
      input.maxTokens = Math.min(requested ?? ceiling.outputTokens, ceiling.outputTokens, ceiling.totalTokens - predicted);
      input.maxRetries = 0;
      input.maxProviderRequests = 1;
      input.abortSignal = input.abortSignal ? AbortSignal.any([input.abortSignal, invocation.signal]) : invocation.signal;
      const id = `task-transport:${invocation.runId}:${randomUUID()}`;
      // Single-owner transport: reserve the entire available input/total ceiling.
      // The estimate admits context, but is never treated as a billing upper bound.
      await account.coordinator.reserve(id, { inputTokens: ceiling.inputTokens, outputTokens: input.maxTokens, totalTokens: ceiling.totalTokens });
      try { input.abortSignal.throwIfAborted(); await account.assertOwnership(); }
      catch (error) { await account.coordinator.settle(id, zero); throw error; }
      return { id, toolsDenied, admission: { accountRunId: account.accountRunId, operationId: id, category: closure ? 'closure' : options.auxiliary ? 'compaction' : 'execution', closureReserve: account.policy.closureReserve, inputCeiling: ceiling.inputTokens, monetaryRefused: false, assertActive: () => account.assertLocalAdmission() } satisfies TaskUsageAdmission };
    };
    const settle = async (id: string, usage?: TokenUsage) => {
      // Missing terminal receipts stay spent. No automatic reconciliation or release.
      await account.coordinator.settle(id, completeUsage(usage));
    };
    const failedUsage = (error: unknown, provider: string) => error instanceof ProviderToolCallError &&
      error.provider === provider && error.usageComplete ? error.usage : undefined;
    return { name: 'harness-task-budget-v1',
      async wrapGenerate(context, next) {
        const { id, toolsDenied, admission } = await begin(context);
        let receipt = false, dispatched = false;
        try { account.assertLocalAdmission(); dispatched = true;
          const result = await taskUsageAdmission.run(admission, next); receipt = true; await settle(id, result.usage);
          if (toolsDenied && (result.finishReason === 'tool-calls' || result.messages?.some(message => message.parts.some(part => part.type === 'tool-call')))) throw new Error('TASK_BUDGET_CLOSURE_TOOLS_DENIED');
          return result; }
        catch (error) { if (!receipt) { try { await settle(id, !dispatched || admission.monetaryRefused ? zero : failedUsage(error, context.model.provider)); } catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } } throw error; }
      },
      async wrapStream(context, next) {
        const { id, toolsDenied, admission } = await begin(context);
        let dispatched = false;
        try {
          account.assertLocalAdmission(); dispatched = true;
          const stream = await taskUsageAdmission.run(admission, next);
          return (async function* () {
            let receipt = false;
            try { for await (const event of stream) {
              if (toolsDenied && event.type === 'tool-call') throw new Error('TASK_BUDGET_CLOSURE_TOOLS_DENIED');
              if (event.type === 'finish' && !receipt) { receipt = true; await settle(id, event.usage); }
              yield event;
            } } catch (error) {
              if (!receipt) { receipt = true; try { await settle(id, admission.monetaryRefused ? zero : failedUsage(error, context.model.provider)); }
                catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } }
              throw error;
            } finally { if (!receipt) await settle(id); }
          })();
        } catch (error) { try { await settle(id, !dispatched || admission.monetaryRefused ? zero : failedUsage(error, context.model.provider)); } catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } throw error; }
      }
    };
  }
  checkpointStore(store: AgentRunStore): AgentRunStore {
    const account = this;
    return new Proxy(store, { get(target, key) {
      if (key === 'save') return async (...args: Parameters<AgentRunStore['save']>) => {
        const invocation = active.getStore();
        if (invocation?.account === account && args[0].runId === invocation.runId) {
          await account.assertOwnership({ allowCancelled: ['cancelled', 'timed_out', 'failed'].includes(args[0].status) });
          args[0].metadata = { ...args[0].metadata, [TASK_BUDGET_KEY]: serializeJsonValue(await account.summary()) };
        }
        return target.save(...args);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
