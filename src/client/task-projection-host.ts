import { createHash } from 'node:crypto';
import { createRedactionPolicy } from '@zhivex-ai/agents';
import type { ZhivexHarness } from '../runtime/harness.js';
import { readTaskAcceptanceLedger } from '../runtime/task-acceptance-record.js';
import { inspectTaskBudgetSummary, TASK_BUDGET_KEY, TaskBudget } from '../runtime/task-budget.js';
import { readTaskContinuityEvidence } from '../runtime/task-continuity.js';
import { harnessTaskProjectionSchema, type HarnessTaskProjection, type HarnessTaskProjectionScope } from './task-projection.js';

export type TaskProjectionCause = 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_HOST' | 'OUT_OF_SCOPE' | 'CONTRACT_UNAVAILABLE' | 'EVIDENCE_UNAVAILABLE' | 'SNAPSHOT_CHANGED' | 'PAYLOAD_LIMIT';
export class TaskProjectionFault extends Error {
  constructor(readonly causeCode: TaskProjectionCause) { super(causeCode); }
}
const fault = (cause: TaskProjectionCause): never => { throw new TaskProjectionFault(cause); };
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha = (value: unknown): string | null => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;

/** Derivation only: no session refresh, ledger creation, state save, checks or model calls. */
export async function projectHarnessTask(host: ZhivexHarness, request: HarnessTaskProjectionScope & { sequence: number },
  allowedRunIds: readonly string[], sensitiveValues: readonly string[] = []): Promise<HarnessTaskProjection> {
  try {
    if (host.config.execution.backend !== 'none' || host.config.orchestration.profiles.length || host.agent.subagents?.length) return fault('UNSUPPORTED_HOST');
    if (!allowedRunIds.includes(request.runId)) return fault('OUT_OF_SCOPE');
    const state = await host.store.load(request.runId, host.config.scope);
    if (!state) return fault('EVIDENCE_UNAVAILABLE');
    const ledger = readTaskAcceptanceLedger(state);
    if (!ledger) return fault('CONTRACT_UNAVAILABLE');
    const taskId = ledger.revisions.at(-1)!.contract.taskId;
    const rawBudget = state.metadata?.[TASK_BUDGET_KEY];
    const accountId = TaskBudget.accountId(host.config.scope, taskId);
    if (rawBudget === undefined && await host.store.load(accountId, host.config.scope)) return fault('EVIDENCE_UNAVAILABLE');
    const binding = inspectTaskBudgetSummary(rawBudget);
    if (rawBudget !== undefined && (!binding || binding.taskId !== taskId)) return fault('EVIDENCE_UNAVAILABLE');
    const evidence = await readTaskContinuityEvidence(host, taskId, {
      allowedRunIds, ...(rawBudget === undefined ? { legacyRunId: request.runId } : {})
    });
    const report = evidence.report, latest = report.runs.at(-1), current = report.currentContract;
    if (report.reasons.some(reason => ['TASK_CONTINUITY_RUN_MISSING', 'TASK_CONTINUITY_SOURCE_INVALID'].includes(reason))) return fault('EVIDENCE_UNAVAILABLE');
    if (!latest || !current || !report.runs.some(run => run.runId === request.runId)) return fault('EVIDENCE_UNAVAILABLE');
    if (binding && (binding.accountRunId !== report.budget?.accountRunId || binding.coordinatorId !== report.budget?.coordinatorId)) return fault('EVIDENCE_UNAVAILABLE');
    const redaction = createRedactionPolicy({ includeEmails: true });
    let textTruncated = false;
    const text = (raw: string): string => {
      let safe = raw;
      for (const secret of [host.workspace.root, ...sensitiveValues]) if (secret) safe = safe.split(secret).join('[REDACTED]');
      safe = redaction.redactText(safe).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, '[REDACTED]')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (safe.length > 2048) { textTruncated = true; safe = safe.slice(0, 2047) + '…'; }
      return safe;
    };
    const delivery = object(latest.delivery);
    const deliveredDigest = sha(delivery.snapshotDigest);
    const observedDigest = latest.snapshot?.snapshotDigest ?? null;
    // Digest equality alone is insufficient: bind delivery to the exact run and native identity.
    const correspondence = observedDigest && deliveredDigest && latest.snapshot && delivery.runId === latest.runId &&
      delivery.executionIdentity === latest.snapshot.executionIdentity && delivery.patchId === latest.snapshot.patchId
      ? observedDigest === deliveredDigest ? 'current' : 'stale' : deliveredDigest ? 'stale' : 'missing';
    const effects = report.runs.flatMap(run => run.effects);
    const missingEvidence = report.reasons.some(reason => /EFFECT_(?:EVIDENCE_MISSING|UNCERTAIN)/.test(reason));
    const budget = report.budget;
    const reasons = [...report.reasons];
    if (budget && Object.values(budget.remaining).some(value => value === 0)) reasons.push('TASK_BUDGET_EXHAUSTED');
    const blocked = reasons.length > 0;
    const execution = (['created', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out'] as const).find(status => status === latest.status) ?? 'unknown';
    const structure = execution === 'completed' && correspondence === 'current' && latest.hostPolicyCompatible &&
      latest.checks.every(check => check.status === 'confirmed') && !missingEvidence ? 'verified' : 'incomplete';
    const task: HarnessTaskProjection['task'] = {
      reference: hash(['task', taskId]), contractRevision: current.revision, contractDigest: current.digest, runRevision: latest.revision ?? 0,
      objective: latest.objective === null ? null : text(latest.objective),
      objectiveSource: latest.objective === null ? 'unavailable' : latest.briefStatus === 'current' ? 'operator_brief' : 'retained_operator_source',
      observedRunId: latest.runId, historicalRequest: latest.runId !== request.runId, execution,
      artifact: { observedDigest, deliveredDigest, correspondence, paths: current.contract.allowedWritePaths.map(text), contents: 'not_included' },
      review: { structure, semantic: 'pending', acceptance: 'not_recorded', human: current.contract.humanReview.map(row => ({ id: text(row.id), requirement: text(row.requirement), status: 'pending' })),
        checks: latest.checks.map(check => ({ id: text(check.id), status: check.status as HarnessTaskProjection['task']['review']['checks'][number]['status'], provenance: 'contract_snapshot_and_tool_journal' })) },
      budget: { availability: budget ? 'authoritative' : 'legacy_not_enabled', revision: budget?.revision ?? null,
        confirmed: budget?.confirmed ?? null, reserved: budget?.reserved ?? null, unknown: budget?.unknown ?? null,
        remaining: budget?.remaining ?? null, limits: budget?.limits ?? null, estimated: null, estimation: 'not_separately_recorded',
        usageComplete: budget?.usageComplete ?? null, admissionsClosed: budget?.admissionsClosed ?? null,
        monetary: { estimatedConfirmedUsd: budget?.monetaryDetails.estimatedConfirmedUsd ?? null, reservedUsd: budget?.monetaryDetails.reservedUsd ?? null, unknownHeldUsd: budget?.monetaryDetails.unknownHeldUsd ?? null, remainingUsd: budget?.monetaryDetails.remainingUsd ?? null, unknown: !budget || !budget.monetaryDetails.costComplete, costKind: 'estimate-not-invoice' } },
      effects: { readOnly: effects.filter(row => row.status === 'read_only').length, recorded: effects.filter(row => row.status === 'recorded').length,
        unknown: effects.filter(row => row.status === 'unknown').length, missingEvidence, automaticReplay: false, providerStopped: 'unconfirmed' },
      nextAction: { kind: blocked ? 'reconcile' : ['created', 'queued', 'running', 'cancel_requested'].includes(execution) ? 'wait'
        : execution === 'waiting_approval' ? 'review_approval' : structure === 'verified' ? 'review_delivery' : 'explicit_continuation',
        permitted: 'read_only', authorization: 'required_for_execution', preserves: 'contract_receipts_budget_and_effects', automaticReplay: false },
      diagnostic: execution === 'failed' ? { code: 'EXECUTION_FAILED', cause: 'execution_terminal_failure', impact: 'acceptance_not_established', safeAction: missingEvidence ? 'reconcile' : 'review_configuration' }
        : execution === 'cancelled' ? { code: 'EXECUTION_CANCELLED', cause: 'operator_or_runtime_cancellation', impact: 'acceptance_not_established', safeAction: 'reconcile' }
        : execution === 'timed_out' ? { code: 'EXECUTION_TIMED_OUT', cause: 'execution_deadline', impact: 'acceptance_not_established', safeAction: 'reconcile' }
        : structure !== 'verified' ? { code: 'EVIDENCE_INCOMPLETE', cause: 'receipts_missing_or_stale', impact: 'acceptance_not_established', safeAction: 'review_delivery' } : null,
      reasons, provenance: 'host_durable_contract_journal_budget_and_fresh_native_snapshot', textTruncated
    };
    // Revalidate all inputs after projection; a changing workspace is not a fresh authorization.
    await evidence.verifyAll();
    if (rawBudget === undefined && await host.store.load(accountId, host.config.scope)) return fault('SNAPSHOT_CHANGED');
    if (JSON.stringify(await host.store.load(request.runId, host.config.scope)) !== JSON.stringify(state)) return fault('SNAPSHOT_CHANGED');
    const projection = { schemaVersion: 1 as const, ...request, task };
    if (Buffer.byteLength(JSON.stringify(projection)) > 64 * 1024) return fault('PAYLOAD_LIMIT');
    return harnessTaskProjectionSchema.parse(projection);
  } catch (error) {
    if (error instanceof TaskProjectionFault) throw error;
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    if (code === 'TASK_PROJECTION_SCOPE_MISMATCH') return fault('OUT_OF_SCOPE');
    if (code === 'TASK_CONTINUITY_CHANGED') return fault('SNAPSHOT_CHANGED');
    if (code === 'TASK_CONTINUITY_CAPACITY' || code === 'TASK_ACCEPTANCE_HISTORY_CAPACITY') return fault('PAYLOAD_LIMIT');
    return fault('EVIDENCE_UNAVAILABLE');
  }
}
