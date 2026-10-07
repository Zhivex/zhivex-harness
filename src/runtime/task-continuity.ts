import { createHash } from 'node:crypto';
import type { AgentRunState, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import type { ZhivexHarness } from './harness.js';
import { inspectHarnessTaskBudget } from './task-budget-host.js';
import { readTaskAcceptanceLedger, TASK_ACCEPTANCE_EVIDENCE_KEY } from './task-acceptance-record.js';
import { createTaskAcceptanceChecks } from './task-acceptance-checks.js';
import { nativeTaskSnapshot } from './task-acceptance-native.js';
import { compileTaskAcceptanceContract } from './task-acceptance.js';
import { taskSources, assistantResponses } from '../context/task-memory.js';
import { approvalDecisionViews, APPROVAL_HISTORY_KEY } from '../approvals/approval-history.js';

const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const reads = new Set(['list_files', 'read_file', 'read_files', 'read_dependency', 'search_files', 'search_many', 'read_task', 'git_diff', 'mutation_audit']);
const sameScope = (a: AgentRunState['scope'], b: AgentRunState['scope']) =>
  ['tenantId', 'userId', 'namespace'].every(key => a?.[key as keyof typeof a] === b?.[key as keyof typeof b]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Internal read set, checked again inside task invocation admission. No new store or recovery credit. */
export async function readTaskContinuity(host: ZhivexHarness, taskId: string) {
  const budget = await inspectHarnessTaskBudget(host, taskId);
  const reasons = new Set<string>();
  const observed: { state: AgentRunState; journal: AgentToolCallJournalEntry[] }[] = [];
  const absent: string[] = [];
  const snapshots: { runId: string; ledger: NonNullable<ReturnType<typeof readTaskAcceptanceLedger>>; snapshot: Awaited<ReturnType<typeof nativeTaskSnapshot>> }[] = [];
  const runs = [];
  if (budget.invocationPending) reasons.add('TASK_BUDGET_INVOCATION_UNCERTAIN');
  if (budget.admissionsClosed) reasons.add('TASK_BUDGET_CANCELLED');
  if (!budget.usageComplete) reasons.add('TASK_BUDGET_UNCERTAIN');
  if (budget.runs.length > 256) throw new Error('TASK_CONTINUITY_CAPACITY');
  for (const runId of budget.runs) {
    const loaded = await host.store.load(runId, host.config.scope);
    if (!loaded) { absent.push(runId); reasons.add('TASK_CONTINUITY_RUN_MISSING'); continue; }
    const state = structuredClone(loaded);
    if (state.schemaVersion !== 1 || !sameScope(state.scope, host.config.scope)) throw new Error('TASK_CONTINUITY_STATE_INVALID');
    let ledger: ReturnType<typeof readTaskAcceptanceLedger>;
    try { ledger = readTaskAcceptanceLedger(state); } catch { throw new Error('TASK_CONTINUITY_CONTRACT_INVALID'); }
    if (!ledger || ledger.revisions.at(-1)!.contract.taskId !== taskId) throw new Error('TASK_CONTINUITY_CONTRACT_MISSING');
    if (!host.store.listToolCalls) throw new Error('TASK_CONTINUITY_JOURNAL_UNAVAILABLE');
    const journal = structuredClone(await host.store.listToolCalls(runId, host.config.scope));
    if (journal.length > 2048) throw new Error('TASK_CONTINUITY_CAPACITY');
    if (journal.some(row => row.runId !== runId || !sameScope(row.scope, state.scope))) throw new Error('TASK_CONTINUITY_SCOPE_MISMATCH');
    observed.push({ state, journal });
    const effects = journal.map(row => ({ id: row.toolCallId, tool: row.toolName, revision: row.revision,
      status: reads.has(row.toolName) ? 'read_only' : row.status === 'completed' && row.output !== undefined ? 'recorded' : 'unknown',
      retry: reads.has(row.toolName) ? 'fresh_read_within_budget' : 'never_automatic' }));
    if (effects.some(row => row.status === 'unknown')) reasons.add('TASK_CONTINUITY_EFFECT_UNCERTAIN');
    // A retained tool result or call is evidence of a missing journal, never proof that replay is safe.
    const currentCalls = state.steps.flatMap(step => (step.response?.messages ?? []).flatMap(message => message.parts.flatMap(part => part.type === 'tool-call' ? [part.toolCall] : [])));
    const calls = state.messages.flatMap((message, index) => message.parts.flatMap(part => part.type === 'tool-call' ? [{ call: part.toolCall, index }] : []));
    for (const { call, index } of calls) {
      // Earlier turns retain their transcript, while receipts remain owned by the original run.
      // Require an exact inherited prefix and never use history for this run's generated calls.
      const inherited = !currentCalls.some(item => item.id === call.id) && observed.slice(0, -1).some(prior =>
        prior.state.messages.some((message, priorIndex) => {
          if (!message.parts.some(part => part.type === 'tool-call' && JSON.stringify(part.toolCall) === JSON.stringify(call))) return false;
          // Runtime context injection can insert system/retained-assistant context before the conversation.
          const start = prior.state.messages.findIndex(item => item.role !== 'system');
          const prefix = prior.state.messages.slice(start, priorIndex + 1);
          return start >= 0 && index + 1 >= prefix.length && prefix.every((item, offset) => JSON.stringify(item) === JSON.stringify(state.messages[index + 1 - prefix.length + offset]));
        }) &&
        prior.journal.some(row => row.providerToolCallId === call.id && row.toolName === call.name && JSON.stringify(row.input) === JSON.stringify(call.input)));
      const waiting = state.pendingApprovals.some(approval => approval.toolCallId === call.id);
      if (!reads.has(call.name) && !waiting && !inherited && !journal.some(row => row.providerToolCallId === call.id && row.toolName === call.name)) reasons.add('TASK_CONTINUITY_EFFECT_EVIDENCE_MISSING');
    }
    for (const result of state.toolResults) if (!reads.has(result.toolName) && !journal.some(row => row.providerToolCallId === result.toolCallId && row.toolName === result.toolName)) reasons.add('TASK_CONTINUITY_EFFECT_EVIDENCE_MISSING');
    const sources = taskSources(state.metadata);
    const rawSources = state.metadata?.zhivexTaskSources;
    if (rawSources !== undefined && (!Array.isArray(rawSources) || sources.length !== rawSources.length) || sources.some(source => hash(source.text) !== source.id)) reasons.add('TASK_CONTINUITY_SOURCE_INVALID');
    const latest = ledger.revisions.at(-1)!;
    const compatible = state.harness?.id === host.agent.harness?.id && state.harness?.version === host.agent.harness?.version &&
      state.harness?.fingerprint === host.agent.harness?.fingerprint;
    const raw = object(state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]);
    let checks = latest.contract.requiredChecks.map(check => ({ id: check.id, status: 'missing' }));
    let snapshot: Awaited<ReturnType<typeof nativeTaskSnapshot>> | undefined;
    try {
      snapshot = await nativeTaskSnapshot(host.workspace, ledger, runId);
      const recovered = createTaskAcceptanceChecks(ledger, raw.checks, journal);
      const missing = new Set(recovered.missing(snapshot));
      checks = checks.map(check => ({ ...check, status: !compatible ? 'host_policy_changed' : missing.has(check.id) ? 'missing_or_stale' : 'confirmed' }));
      if (Array.isArray(raw.checks) && raw.checks.length && recovered.snapshot().length !== raw.checks.length) reasons.add('TASK_CONTINUITY_CHECK_EVIDENCE_MISSING');
      if (raw.delivery && object(raw.delivery).snapshotDigest !== snapshot.snapshotDigest) {
        for (const path of [...latest.contract.allowedWritePaths, ...latest.contract.protectedFiles]) await host.workspace.inspectFile(path);
      }
    } catch { reasons.add('TASK_CONTINUITY_ARTIFACT_UNAVAILABLE'); }
    if (snapshot) snapshots.push({ runId, ledger, snapshot });
    const decisions = Array.from({ length: 21 }, (_, page) => approvalDecisionViews(state, journal, page * 25)).flat();
    const codeBrief = object(state.metadata?.zhivexCodeTaskV1);
    let briefCurrent = false;
    try { briefCurrent = compileTaskAcceptanceContract(codeBrief.contract).digest === latest.digest; } catch { /* Absent/old brief never overrides the contract. */ }
    runs.push({ runId, revision: state.revision, status: state.status, ledger, sources, decisions,
      decisionsAvailability: state.metadata?.[APPROVAL_HISTORY_KEY] === undefined ? 'unavailable' : 'recorded',
      briefStatus: state.metadata?.zhivexCodeTaskV1 === undefined ? 'unavailable' : briefCurrent ? 'current' : 'stale',
      objective: briefCurrent && typeof codeBrief.goal === 'string' ? codeBrief.goal : (sources.find(source => source.original) ?? sources[0])?.text ?? null,
      constraints: briefCurrent && Array.isArray(codeBrief.constraints) && codeBrief.constraints.every(value => typeof value === 'string') ? codeBrief.constraints : [],
      hostPolicyCompatible: compatible,
      assistantResponses: assistantResponses(state.metadata).map(response => ({ ...response, untrusted: true, verified: false })),
      effects, checks, snapshot: snapshot ?? null,
      delivery: raw.delivery ?? null, humanReview: latest.contract.humanReview, fingerprint: state.harness ?? null });
  }
  const latest = runs.at(-1);
  const current = latest?.ledger.revisions.at(-1);
  if (latest && ['created', 'running', 'cancel_requested'].includes(latest.status)) reasons.add('TASK_CONTINUITY_FINALIZATION_UNCONFIRMED');
  if (latest && !latest.sources.length) reasons.add('TASK_CONTINUITY_SOURCE_MISSING');
  const report = { schemaVersion: 1 as const, taskId, budget, runs, currentContract: current ?? null,
    reasons: [...reasons], nextAction: reasons.size ? 'review_blockers' : latest?.status === 'waiting_approval' ? 'review_pending_approval'
      : latest?.status === 'completed' && latest.checks.every(check => check.status === 'confirmed') ? 'human_review' : 'explicit_budgeted_continuation',
    authorization: 'none' as const, automaticEffectReplay: false as const };
  if (Buffer.byteLength(JSON.stringify(report)) > 2 * 1024 * 1024) throw new Error('TASK_CONTINUITY_CAPACITY');
  const verify = async () => {
    for (const id of absent) if (await host.store.load(id, host.config.scope)) throw new Error('TASK_CONTINUITY_CHANGED');
    for (const item of observed) {
      if (JSON.stringify(await host.store.load(item.state.runId, host.config.scope)) !== JSON.stringify(item.state) ||
        JSON.stringify(await host.store.listToolCalls!(item.state.runId, host.config.scope)) !== JSON.stringify(item.journal)) throw new Error('TASK_CONTINUITY_CHANGED');
    }
    for (const run of snapshots) if ((await nativeTaskSnapshot(host.workspace, run.ledger, run.runId)).snapshotDigest !== run.snapshot.snapshotDigest) throw new Error('TASK_CONTINUITY_CHANGED');
  };
  await verify();
  if (JSON.stringify(await inspectHarnessTaskBudget(host, taskId)) !== JSON.stringify(budget)) throw new Error('TASK_CONTINUITY_CHANGED');
  return { report, verify };
}

/** Host-only Experimental inspection; no model, writes, approval, cancellation revival or replay. */
export async function inspectHarnessTaskContinuity(host: ZhivexHarness, taskId: string) {
  return (await readTaskContinuity(host, taskId)).report;
}
