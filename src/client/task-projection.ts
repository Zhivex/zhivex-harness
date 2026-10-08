import { z } from 'zod';

/** Experimental, additive read contract. No runtime, filesystem or renderer authority. */
export const HARNESS_TASK_PROJECTION_VERSION = 1 as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().max(2048);
const tokens = z.strictObject({ inputTokens: count, outputTokens: count, totalTokens: count });
export const harnessTaskProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1), connectionId: id, sequence: count,
  projectId: id, sessionId: id, runId: id,
  task: z.strictObject({
    reference: digest, contractRevision: count, contractDigest: digest, runRevision: count,
    objective: text.nullable(), objectiveSource: z.enum(['operator_brief', 'retained_operator_source', 'unavailable']),
    observedRunId: id, historicalRequest: z.boolean(),
    execution: z.enum(['created', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown']),
    artifact: z.strictObject({ observedDigest: digest.nullable(), deliveredDigest: digest.nullable(), correspondence: z.enum(['current', 'stale', 'missing']),
      paths: z.array(text).max(256), contents: z.literal('not_included') }),
    review: z.strictObject({ structure: z.enum(['verified', 'incomplete']), semantic: z.literal('pending'), acceptance: z.literal('not_recorded'),
      human: z.array(z.strictObject({ id: text, requirement: text, status: z.literal('pending') })).max(32),
      checks: z.array(z.strictObject({ id: text, status: z.enum(['confirmed', 'missing', 'missing_or_stale', 'host_policy_changed']), provenance: z.literal('contract_snapshot_and_tool_journal') })).max(32) }),
    budget: z.strictObject({ availability: z.enum(['authoritative', 'legacy_not_enabled']), revision: count.nullable(),
      confirmed: tokens.nullable(), reserved: tokens.nullable(), unknown: tokens.nullable(), remaining: tokens.nullable(), limits: tokens.nullable(),
      estimated: z.null(), estimation: z.literal('not_separately_recorded'), usageComplete: z.boolean().nullable(), admissionsClosed: z.boolean().nullable(),
      monetary: z.strictObject({ estimatedConfirmedUsd: z.number().finite().nonnegative().nullable(), reservedUsd: z.number().finite().nonnegative().nullable(), unknownHeldUsd: z.number().finite().nonnegative().nullable(), remainingUsd: z.number().finite().nonnegative().nullable(), unknown: z.boolean(), costKind: z.literal('estimate-not-invoice') }) }),
    effects: z.strictObject({ readOnly: count, recorded: count, unknown: count, missingEvidence: z.boolean(), automaticReplay: z.literal(false), providerStopped: z.literal('unconfirmed') }),
    nextAction: z.strictObject({ kind: z.enum(['wait', 'reconcile', 'review_approval', 'review_delivery', 'explicit_continuation']),
      permitted: z.literal('read_only'), authorization: z.literal('required_for_execution'), preserves: z.literal('contract_receipts_budget_and_effects'), automaticReplay: z.literal(false) }),
    diagnostic: z.strictObject({ code: z.enum(['EXECUTION_FAILED', 'EXECUTION_CANCELLED', 'EXECUTION_TIMED_OUT', 'EVIDENCE_INCOMPLETE']), cause: z.enum(['execution_terminal_failure', 'operator_or_runtime_cancellation', 'execution_deadline', 'receipts_missing_or_stale']), impact: z.literal('acceptance_not_established'), safeAction: z.enum(['review_configuration', 'reconcile', 'review_delivery']) }).nullable(),
    reasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).max(32),
    provenance: z.literal('host_durable_contract_journal_budget_and_fresh_native_snapshot'), textTruncated: z.boolean()
  })
});
export type HarnessTaskProjection = z.infer<typeof harnessTaskProjectionSchema>;
export type HarnessTaskProjectionScope = Pick<HarnessTaskProjection, 'connectionId' | 'projectId' | 'sessionId' | 'runId'>;

/** Snapshot replacement only. The caller supplies its negotiated epoch and selected scope.
 * Activity events only invalidate this view; replay/cursor expiry requires a fresh task.get.
 */
export function reduceHarnessTaskProjection(current: HarnessTaskProjection | null, incoming: unknown, expected: HarnessTaskProjectionScope):
  { status: 'applied' | 'ignored' | 'refresh_required'; snapshot: HarnessTaskProjection | null } {
  const inScope = (value: HarnessTaskProjection) => (['connectionId', 'projectId', 'sessionId', 'runId'] as const).every(key => value[key] === expected[key]);
  const previous = harnessTaskProjectionSchema.safeParse(current);
  const retained = previous.success && inScope(previous.data) ? previous.data : null;
  let encoded: string;
  try { encoded = JSON.stringify(incoming); } catch { return { status: 'refresh_required', snapshot: retained }; }
  if (new TextEncoder().encode(encoded).length > 64 * 1024) return { status: 'refresh_required', snapshot: retained };
  const parsed = harnessTaskProjectionSchema.safeParse(incoming);
  if (!parsed.success || !inScope(parsed.data)) return { status: 'refresh_required', snapshot: retained };
  if (retained && parsed.data.sequence <= retained.sequence) {
    if (parsed.data.sequence === retained.sequence && JSON.stringify(parsed.data) !== JSON.stringify(retained)) return { status: 'refresh_required', snapshot: retained };
    return { status: 'ignored', snapshot: retained };
  }
  return { status: 'applied', snapshot: parsed.data };
}
