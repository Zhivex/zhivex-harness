import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAgentBudgetCoordinator, fingerprintAgentHarness, serializeJsonValue,
  type AgentRunState, type AgentStoreScope, type LanguageModelMiddleware, type TokenUsage, type ToolSet } from '@zhivex-ai/core';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import { ProviderToolCallError } from '@zhivex-ai/core/provider';
import { estimateRequestTokens } from './model-budget.js';
import { withRuntimeInstruction } from './runtime-instructions.js';
import { usagePricingSchema, type UsageAccountingOptions } from './usage-ledger.js';

export const TASK_BUDGET_KEY = 'zhivexTaskBudgetV1';
export const TASK_BUDGET_ACCOUNT_KEY = 'zhivexTaskBudgetAccountV1';
const token = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokensSchema = z.strictObject({ inputTokens: token, outputTokens: token, totalTokens: token });
const policySchema = z.strictObject({ limits: tokensSchema, closureReserve: z.number().min(0).max(0.9),
  usageAccounting: z.strictObject({ pricing: usagePricingSchema.optional(), limitUsd: z.number().finite().positive().optional(),
    requireCompleteUsage: z.boolean().optional() }).optional() });
const accountSchema = z.strictObject({ schemaVersion: z.literal(1), taskId: z.string().min(1).max(256),
  policy: policySchema, runs: z.array(z.string().min(1).max(256)).max(4096), admissionsClosed: z.boolean(),
  invocation: z.strictObject({ runId: z.string().min(1).max(256), ownerId: z.string().min(1).max(256) }).optional() });
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
      const account = accountSchema.parse(rawAccount);
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
    const account = accountSchema.parse(root.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
    if (account.taskId !== projection.taskId || root.budgetCoordinatorId !== projection.coordinatorId ||
        JSON.stringify(account.policy.limits) !== JSON.stringify(projection.limits) ||
        (!state.runId.startsWith('task_draft_') && !account.runs.includes(state.runId))) throw new Error('TASK_BUDGET_BACKUP_BINDING_MISMATCH');
  }
}
export interface TaskBudgetPolicy { limits: { inputTokens: number; outputTokens: number; totalTokens: number };
  closureReserve?: number; usageAccounting?: UsageAccountingOptions }
type Account = z.infer<typeof accountSchema>;
const active = new AsyncLocalStorage<{ account: TaskBudget; runId: string; ownerId: string; signal: AbortSignal;
  effects: Set<Promise<unknown>> }>();
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
      const account = accountSchema.parse({ schemaVersion: 1, taskId: options.taskId, policy: { ...options.policy,
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
    const account = accountSchema.parse(state.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
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
    const account = accountSchema.parse(state.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
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
  private async update(ownerId: string, mutate: (account: Account) => void, expectedRevision?: number) {
    const { state, account } = await this.state();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error('TASK_BUDGET_REVISION_CONFLICT');
    mutate(account);
    accountSchema.parse(account);
    await this.options.store.save({ ...state, revision: (state.revision ?? 0) + 1, updatedAt: this.now(),
      metadata: { ...state.metadata, [TASK_BUDGET_ACCOUNT_KEY]: serializeJsonValue(account) } },
      { expectedRevision: state.revision ?? 0, leaseOwnerId: ownerId });
  }
  /** Recheck the task lease immediately before each admitted local action/checkpoint. */
  async assertOwnership(options: { allowCancelled?: boolean } = {}) {
    const invocation = active.getStore();
    if (!invocation || invocation.account !== this) throw new Error('TASK_BUDGET_SCOPE_REQUIRED');
    if (!options.allowCancelled) invocation.signal.throwIfAborted();
    if (!await this.options.store.renewLease!(this.accountRunId,
      { ownerId: invocation.ownerId, ttlMs: 30_000, now: this.now() }, this.options.scope)) throw new Error('TASK_BUDGET_LEASE_LOST');
    const { account } = await this.state();
    if (account.invocation?.ownerId !== invocation.ownerId || account.invocation.runId !== invocation.runId) throw new Error('TASK_BUDGET_INVOCATION_OWNERSHIP_LOST');
    if (!options.allowCancelled) {
      invocation.signal.throwIfAborted();
      if (account.admissionsClosed) throw new Error('TASK_BUDGET_CANCELLED');
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
    const lost = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal;
    let renewal: Promise<void> | undefined, cancellation: Promise<void> | undefined;
    const close = () => { cancellation ??= this.update(ownerId, account => { account.admissionsClosed = true; }); cancellation.catch(() => {}); };
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
      await this.update(ownerId, account => {
        if (account.invocation) throw new Error('TASK_BUDGET_INVOCATION_UNCERTAIN');
        if (!account.runs.includes(runId)) account.runs.push(runId);
        account.invocation = { runId, ownerId };
      });
      signal.addEventListener('abort', close, { once: true });
      timer = setInterval(() => { if (!renewal) renewal = renew().catch(error => { lost.abort(error); }).finally(() => { renewal = undefined; }); }, 10_000);
      timer.unref?.();
      const effects = new Set<Promise<unknown>>();
      const drain = async () => { while (effects.size) await Promise.allSettled([...effects]); };
      return await active.run({ account: this, runId, ownerId, signal, effects }, async () => {
        try {
          const result = await operation(signal);
          await drain();
          await this.assertOwnership();
          return result;
        } finally {
          await drain();
          await renewal; await cancellation;
          // An expired worker cannot prove that every effect has ended for the
          // new owner. Keep the durable marker until explicit reconciliation.
          await this.assertOwnership({ allowCancelled: true });
          await this.update(ownerId, account => { delete account.invocation; });
        }
      });
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', close);
      if (signal.aborted && !cancellation) close();
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
      return { id, toolsDenied };
    };
    const settle = async (id: string, usage?: TokenUsage) => {
      // Missing terminal receipts stay spent. No automatic reconciliation or release.
      await account.coordinator.settle(id, completeUsage(usage));
    };
    const failedUsage = (error: unknown, provider: string) => error instanceof ProviderToolCallError &&
      error.provider === provider && error.usageComplete ? error.usage : undefined;
    return { name: 'harness-task-budget-v1',
      async wrapGenerate(context, next) {
        const { id, toolsDenied } = await begin(context);
        let receipt = false;
        try { const result = await next(); receipt = true; await settle(id, result.usage);
          if (toolsDenied && (result.finishReason === 'tool-calls' || result.messages?.some(message => message.parts.some(part => part.type === 'tool-call')))) throw new Error('TASK_BUDGET_CLOSURE_TOOLS_DENIED');
          return result; }
        catch (error) { if (!receipt) { try { await settle(id, failedUsage(error, context.model.provider)); } catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } } throw error; }
      },
      async wrapStream(context, next) {
        const { id, toolsDenied } = await begin(context);
        try {
          const stream = await next();
          return (async function* () {
            let receipt = false;
            try { for await (const event of stream) {
              if (toolsDenied && event.type === 'tool-call') throw new Error('TASK_BUDGET_CLOSURE_TOOLS_DENIED');
              if (event.type === 'finish' && !receipt) { receipt = true; await settle(id, event.usage); }
              yield event;
            } } catch (error) {
              if (!receipt) { receipt = true; try { await settle(id, failedUsage(error, context.model.provider)); }
                catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } }
              throw error;
            } finally { if (!receipt) await settle(id); }
          })();
        } catch (error) { try { await settle(id, failedUsage(error, context.model.provider)); } catch (auditError) { throw new AggregateError([error, auditError], 'TASK_BUDGET_UNCERTAIN'); } throw error; }
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
