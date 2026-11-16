import type { AgentApprovalResponse, AgentRunState } from '@zhivex-ai/core';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import { APPROVAL_HISTORY_KEY, approvalInputDigest, readApprovalDecisions, type ApprovalDecisionRecord } from './approval-history.js';
import { hostPolicyIdentity, requiresExplicitHostReview } from './host-policy-identity.js';

type DecisionOrigin = 'interactive' | 'automatic' | 'application';
type Receipt = { alreadyRecorded?: boolean; explicitReview: boolean; origins: DecisionOrigin[]; host: object; binding: string; expiresAt: number; channel: string; reviewedRevision: number };
const receipts = new WeakMap<object, Receipt>();
const issuedResponses = new WeakSet<object>();
/** Presence only; admission still validates and consumes the receipt against durable state. */
export const hasHostApprovalReceipt = (responses: readonly AgentApprovalResponse[]): boolean => issuedResponses.has(responses);
const binding = (host: object, state: AgentRunState, responses: readonly AgentApprovalResponse[], requireComplete = true) => {
  if (state.status !== 'waiting_approval' || !state.pendingApprovals.length || !Number.isSafeInteger(state.revision) || state.revision! < 0) {
    throw new Error('EXPLICIT_REVIEW_INVALID_STATE');
  }
  const pending = state.pendingApprovals;
  const keys = responses.map(response => `${response.provider}\0${response.approvalRequestId}`);
  if ((requireComplete && responses.length !== pending.length) || responses.length > pending.length || new Set(keys).size !== responses.length || responses.some(response =>
    typeof response.approve !== 'boolean' || !pending.some(approval => approval.id === response.approvalRequestId && approval.provider === response.provider))) {
    throw new Error('EXPLICIT_REVIEW_APPROVAL_MISMATCH');
  }
  return approvalInputDigest({ runId: state.runId, scope: state.scope, revision: state.revision,
    harness: state.harness, history: state.metadata?.[APPROVAL_HISTORY_KEY], policyDigest: hostPolicyIdentity(host), pending,
    decisions: responses.map(response => ({ provider: response.provider, id: response.approvalRequestId, approve: response.approve })).sort((a,b) => `${a.provider}\0${a.id}`.localeCompare(`${b.provider}\0${b.id}`)) });
};

/** Trusted host only: call after its review UI confirms the complete snapshot.
 * No renderer/client flag creates evidence. Cloning or serializing loses authority.
 * This attests a local channel, not a person's legal or corporate identity. */
export const issueExplicitReviewResponses = (host: object, state: AgentRunState,
  responses: readonly AgentApprovalResponse[], channel: string, now = Date.now(), reviewedRevision = state.revision!): AgentApprovalResponse[] => {
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(channel) || !hostPolicyIdentity(host)) throw new Error('EXPLICIT_REVIEW_INVALID_HOST');
  if (!Number.isSafeInteger(reviewedRevision) || reviewedRevision < 0 || reviewedRevision > state.revision!) throw new Error('EXPLICIT_REVIEW_INVALID_REVISION');
  const snapshot = structuredClone([...responses]);
  for (const response of snapshot) Object.freeze(response);
  Object.freeze(snapshot);
  issuedResponses.add(snapshot);
  receipts.set(snapshot, { explicitReview: true, origins: snapshot.map(() => 'interactive'), host, binding: binding(host, state, snapshot), expiresAt: now + 5 * 60_000, channel, reviewedRevision });
  return snapshot;
};

/** Observed provenance is separate from evidence of complete explicit review. */
export const issueObservedApprovalResponses = (host: object, state: AgentRunState,
  responses: readonly AgentApprovalResponse[], channel: string, origins: readonly DecisionOrigin[], now = Date.now()): AgentApprovalResponse[] => {
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(channel)) throw new Error('INVALID_APPROVAL_CHANNEL');
  if (origins.length !== responses.length || origins.some(origin => origin !== 'interactive' && origin !== 'automatic' && origin !== 'application')) throw new Error('INVALID_APPROVAL_ORIGINS');
  const snapshot = structuredClone([...responses]);
  for (const response of snapshot) Object.freeze(response);
  Object.freeze(snapshot);
  issuedResponses.add(snapshot);
  receipts.set(snapshot, { explicitReview: false, origins: [...origins], host, binding: binding(host, state, snapshot, false),
    expiresAt: requiresExplicitHostReview(host) ? now + 5 * 60_000 : Number.POSITIVE_INFINITY, channel, reviewedRevision: state.revision! });
  return snapshot;
};

export const issueAutomaticApprovalResponses = (host: object, state: AgentRunState,
  responses: readonly AgentApprovalResponse[], channel: string): AgentApprovalResponse[] =>
  issueObservedApprovalResponses(host, state, responses, channel, responses.map(() => 'automatic'));

/** Internal adapter handoff after its durable intent write; not a protocol field. */
export const issueRecordedApprovalResponses = (host: object, state: AgentRunState,
  responses: readonly AgentApprovalResponse[]): AgentApprovalResponse[] => {
  const history = readApprovalDecisions(state);
  for (const response of responses) {
    const approval = state.pendingApprovals.find(a => a.id === response.approvalRequestId && a.provider === response.provider);
    if (!approval || !history.some(row => row.approvalId === approval.id && row.digest === approvalInputDigest(approval) && row.approved === response.approve)) {
      throw new Error('APPROVAL_INTENT_NOT_RECORDED');
    }
  }
  const issued = issueObservedApprovalResponses(host, state, responses, 'client-protocol-v1', responses.map(() => 'application'));
  receipts.get(issued)!.alreadyRecorded = true;
  return issued;
};

export const consumeExplicitReviewResponses = (host: object, state: AgentRunState,
  responses: readonly AgentApprovalResponse[], now = Date.now()): { alreadyRecorded?: boolean; origins: DecisionOrigin[]; channel: string; policyDigest: string | null; reviewedRevision: number } => {
  const receipt = receipts.get(responses);
  // Consume before any persistence or effect; uncertain failures require fresh review.
  receipts.delete(responses);
  if (!receipt || receipt.host !== host) throw new Error('EXPLICIT_REVIEW_REQUIRED');
  if (requiresExplicitHostReview(host) && responses.some(response => response.approve) && !receipt.explicitReview) throw new Error('EXPLICIT_REVIEW_REQUIRED');
  if (now >= receipt.expiresAt) throw new Error('EXPLICIT_REVIEW_EXPIRED');
  if (receipt.binding !== binding(host, state, responses, receipt.explicitReview)) throw new Error('EXPLICIT_REVIEW_STALE');
  return { alreadyRecorded: receipt.alreadyRecorded === true, origins: [...receipt.origins], channel: receipt.channel, policyDigest: hostPolicyIdentity(host), reviewedRevision: receipt.reviewedRevision };
};

/** Save review intent before effects; acknowledgement loss does not authorize retry. */
export const admitExplicitReviewResponses = async (host: object, store: AgentRunStore,
  state: AgentRunState, responses: readonly AgentApprovalResponse[]): Promise<AgentRunState> => {
  const current = await store.load(state.runId, state.scope);
  if (!current) throw new Error('EXPLICIT_REVIEW_STATE_UNAVAILABLE');
  const receipt = consumeExplicitReviewResponses(host, current, responses);
  if (receipt.alreadyRecorded) return current;
  const history = readApprovalDecisions(current);
  if (history.length + responses.length > 512) throw new Error('EXPLICIT_REVIEW_HISTORY_CAPACITY');
  const recorded: ApprovalDecisionRecord[] = responses.map((response, index) => {
    const approval = current.pendingApprovals.find(a => a.provider === response.provider && a.id === response.approvalRequestId)!;
    const digest = approvalInputDigest(approval);
    if (history.some(row => row.approvalId === approval.id && row.digest === digest)) throw new Error('EXPLICIT_REVIEW_ALREADY_RECORDED');
    let inputDigest: string | undefined;
    try { inputDigest = approvalInputDigest(JSON.parse(approval.arguments)); } catch { /* Payload remains bound by approval digest. */ }
    return { approvalId: approval.id, digest, name: approval.name, approved: response.approve,
      decidedAt: Date.now(), reviewedRevision: receipt.reviewedRevision, ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
      ...(inputDigest ? { inputDigest } : {}), provenance: { schemaVersion: 1, origin: receipt.origins[index]!, channel: receipt.channel, policyDigest: receipt.policyDigest } };
  });
  await store.save({ ...current, metadata: { ...current.metadata, [APPROVAL_HISTORY_KEY]: JSON.parse(JSON.stringify([...history, ...recorded])) } }, { expectedRevision: current.revision! });
  const admitted = await store.load(current.runId, current.scope);
  if (!admitted) throw new Error('EXPLICIT_REVIEW_STATE_UNAVAILABLE');
  return admitted;
};
