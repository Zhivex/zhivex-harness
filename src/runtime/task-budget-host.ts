import type { ZhivexHarness } from './harness.js';
import { runUsageLedgerWithPolicy, type UsageAccountingOptions } from './usage-ledger.js';
import { TaskBudget, type TaskBudgetPolicy } from './task-budget.js';
import { fingerprintAgentHarness, serializeJsonValue, type AgentRunState, type AgentStoreScope } from '@zhivex-ai/core';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import { compileTaskAcceptanceContract } from './task-acceptance.js';
import { randomUUID } from 'node:crypto';
import { isTaskTransportModel } from './task-transport.js';

const policies = new WeakMap<object, TaskBudgetPolicy>();

/** Host-only registration: requirements and model metadata cannot establish credit. */
export function bindHarnessTaskBudget(host: ZhivexHarness, usageAccounting?: UsageAccountingOptions) {
  policies.set(host, { limits: { inputTokens: host.config.budget.maxInputTokens,
    outputTokens: host.config.budget.maxOutputTokens, totalTokens: host.config.budget.maxTotalTokens },
    closureReserve: 0.3, usageAccounting: structuredClone(usageAccounting ?? {}) });
}

export async function openHarnessTaskBudget(host: ZhivexHarness, taskId: string, requireExisting = true) {
  const policy = policies.get(host);
  if (!policy) throw new Error('TASK_BUDGET_HOST_UNAVAILABLE');
  if (host.config.storeBackend !== 'sqlite' || !host.persistence?.databasePath)
    throw new Error('TASK_BUDGET_SQLITE_OWNER_REQUIRED');
  if (host.agent.model.provider === 'qwen')
    throw new Error('TASK_BUDGET_OUTPUT_CAP_UNAVAILABLE: direct Code Qwen tasks have no explicit Chat-mode admission; select OpenAI, Anthropic, Gemini or Vertex for a guided task. Ordinary Qwen chat remains available.');
  for (const model of [host.agent.model, ...(host.compactionModel ? [host.compactionModel] : [])]) {
    if (!isTaskTransportModel(model) && model.provider !== 'mock')
      throw new Error('TASK_BUDGET_TRANSPORT_UNSUPPORTED: use a vetted built-in API-key route; Meta and arbitrary custom transports cannot prove bounded dispatch.');
  }
  if (host.config.execution.backend !== 'none' || host.config.orchestration.profiles.length || host.agent.subagents?.length)
    throw new Error('TASK_BUDGET_SINGLE_NATIVE_WRITER_REQUIRED');
  if (host.config.budget.unlimitedTokens) throw new Error('TASK_BUDGET_FINITE_LIMITS_REQUIRED: choose bounded tokens before creating a task.');
  if (!host.usageLedger) throw new Error('TASK_BUDGET_USAGE_ACCOUNTING_REQUIRED');
  return TaskBudget.open({ store: host.store, scope: host.config.scope, taskId, policy, requireExisting });
}

/** Explicit creation is separate from continuation. Reopening never recreates missing credit. */
export async function initializeHarnessTaskBudget(host: ZhivexHarness, taskId: string) {
  const account = await openHarnessTaskBudget(host, taskId, false);
  await runUsageLedgerWithPolicy(host.usageLedger!, account.accountRunId, async () => {}, false, account.policy.usageAccounting);
  return account.summary();
}

/** Read authoritative token and monetary evidence; projections in old checkpoints are only recaps. */
export async function inspectHarnessTaskBudget(host: ZhivexHarness, taskId: string) {
  const account = await openHarnessTaskBudget(host, taskId);
  host.usageLedger!.assertResume(account.accountRunId);
  return { ...await account.summary(), monetary: host.usageLedger!.summary(account.accountRunId) };
}

const TASK_DRAFT_KEY = 'zhivexTaskDraftV1';
const draftId = (scope: AgentStoreScope, sessionId: string) => `task_draft_${fingerprintAgentHarness({ scope, sessionId }).slice('sha256:'.length)}`;

/** A task draft is an application control record, never a completed model run. */
export async function persistHarnessTaskDraft(host: ZhivexHarness, sessionId: string, brief: unknown) {
  if (!sessionId || sessionId.length > 256 || Buffer.byteLength(JSON.stringify(brief)) > 64 * 1024)
    throw new Error('TASK_DRAFT_INVALID');
  const taskId = compileTaskAcceptanceContract((brief as { contract?: unknown })?.contract).contract.taskId;
  const account = await openHarnessTaskBudget(host, taskId);
  const runId = draftId(host.config.scope, sessionId), ownerId = randomUUID();
  if (!host.store.acquireLease || !host.store.releaseLease) throw new Error('TASK_DRAFT_LEASE_REQUIRED');
  if (!await host.store.acquireLease(runId, { ownerId, ttlMs: 30_000 }, host.config.scope)) throw new Error('TASK_DRAFT_ACTIVE');
  try {
    const prior = await host.store.load(runId, host.config.scope);
    const old = prior?.metadata?.[TASK_DRAFT_KEY] as { contract?: unknown } | undefined;
    if (old && compileTaskAcceptanceContract(old.contract).contract.taskId !== taskId) throw new Error('TASK_DRAFT_IDENTITY_MISMATCH');
    const state: AgentRunState = { schemaVersion: 1, runId, scope: host.config.scope, revision: (prior?.revision ?? 0) + 1,
      provider: 'zhivex', modelId: 'task-draft-control', status: 'completed', messages: [], steps: [], toolResults: [],
      pendingApprovals: [], currentStep: 0, maxSteps: 1, outputText: '', updatedAt: Date.now(),
      metadata: { [TASK_DRAFT_KEY]: serializeJsonValue(brief), taskBudgetAccountRunId: account.accountRunId,
        taskDraftOwnerId: ownerId } };
    await host.store.save(state, { expectedRevision: prior?.revision ?? 0, leaseOwnerId: ownerId });
  } finally { await host.store.releaseLease(runId, ownerId, host.config.scope); }
}

export async function readHarnessTaskDraft(store: AgentRunStore, scope: AgentStoreScope, sessionId: string): Promise<unknown | undefined> {
  const state = await store.load(draftId(scope, sessionId), scope);
  return state?.metadata?.[TASK_DRAFT_KEY];
}
