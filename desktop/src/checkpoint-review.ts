import { randomUUID } from 'node:crypto';
import type { HarnessClientData, HarnessClientResponse } from '@zhivex-ai/harness/protocol';

type Restore = Extract<HarnessClientData, { kind: 'restore' }>;
export interface CheckpointReview {
  ticketId: string; operation: Restore['operation']; preview: Restore['preview']; canApply: boolean; redacted: boolean; expiresAt: number;
  recoverySessionId?: string;
  completionOnly?: boolean;
}
/** Main-process authority. The renderer cannot choose a proposal, revision or child at confirmation. */
export function createCheckpointReviewHost(call: (command: Record<string, unknown>) => Promise<HarnessClientResponse>, redact: (value: unknown) => unknown, now = Date.now) {
  const tickets = new Map<string, { command: Record<string, unknown>; expiresAt: number; canApply: boolean }>();
  const read = async (command: Record<string, unknown>) => {
    const result = await call(command); if (!result.ok) throw new Error('CHECKPOINT_REVIEW_UNAVAILABLE'); return result.data;
  };
  const issue = (operation: Restore, command: Record<string, unknown>, canApply: boolean, recoverySessionId?: string): CheckpointReview => {
    const safe = redact(operation.preview) as Restore['preview'];
    const changed = JSON.stringify(safe) !== JSON.stringify(operation.preview);
    const ticketId = randomUUID(), expiresAt = now() + 15 * 60_000;
    tickets.set(ticketId, { command, expiresAt, canApply: canApply && !changed });
    while (tickets.size > 128) tickets.delete(tickets.keys().next().value!);
    return { ticketId, operation: operation.operation, preview: safe, canApply: canApply && !changed, redacted: changed, expiresAt,
      ...(recoverySessionId ? { recoverySessionId } : {}) };
  };
  return {
    async review(sessionId: unknown, operationId: unknown) {
      const source = await read({ method: 'session.get', sessionId });
      const operation = await read({ method: 'restore.get', sessionId, operationId });
      if (source.kind !== 'session' || operation.kind !== 'restore') throw new Error('CHECKPOINT_REVIEW_UNAVAILABLE');
      let completionOnly = false;
      if (['applying', 'applied'].includes(operation.operation.stage) && operation.preview.status === 'unavailable') {
        const inspected = await read({ method: 'checkpoint.inspect', sessionId, checkpointId: operation.operation.checkpointId });
        completionOnly = inspected.kind === 'checkpoint' && inspected.inspection.files.length > 0 && inspected.inspection.files.every(file =>
          file.status === 'available' && file.expectedDigest === file.afterDigest);
      }
      return { ...issue(operation, { method: 'restore.apply', sessionId, operationId, expectedRevision: source.session.revision,
        reviewedProposalId: operation.operation.proposalId }, operation.preview.status === 'available' && operation.preview.diff.files.length > 0 &&
        operation.preview.diff.files.every(file => typeof file.before === 'string' && typeof file.after === 'string') &&
        operation.preview.diff.proposalId === operation.operation.proposalId &&
        ['prepared', 'forked', 'applying'].includes(operation.operation.stage) || completionOnly), completionOnly };
    },
    async reviewRecovery(sessionId: unknown, operationId: unknown, forkSessionId: unknown) {
      const source = await read({ method: 'session.get', sessionId });
      const operation = await read({ method: 'restore.get', sessionId, operationId });
      const child = await read({ method: 'session.get', sessionId: forkSessionId });
      if (source.kind !== 'session' || operation.kind !== 'restore' || child.kind !== 'session' || operation.operation.stage !== 'forking') throw new Error('CHECKPOINT_RECOVERY_UNAVAILABLE');
      const checkpoint = await read({ method: 'checkpoint.inspect', sessionId, checkpointId: operation.operation.checkpointId });
      if (checkpoint.kind !== 'checkpoint' || child.session.parentSessionId !== source.session.sessionId ||
        child.session.forkedFromTurnId !== checkpoint.inspection.checkpoint.turnId || child.session.title !== `restore:${operationId}`) throw new Error('CHECKPOINT_RECOVERY_MISMATCH');
      return issue(operation, { method: 'restore.recoverFork', sessionId, operationId, forkSessionId,
        expectedRevision: source.session.revision }, true, child.session.sessionId);
    },
    async resolve(ticketId: unknown, approve: unknown) {
      if (typeof ticketId !== 'string' || typeof approve !== 'boolean') throw new Error('INVALID_DECISION');
      const ticket = tickets.get(ticketId); if (!ticket) throw new Error('REVIEW_REQUIRED');
      tickets.delete(ticketId);
      if (!approve) return null;
      if (ticket.expiresAt <= now()) throw new Error('REVIEW_EXPIRED');
      if (!ticket.canApply) throw new Error('REVIEW_INCOMPLETE');
      // Consume before transport; reconcile uncertain outcomes using restore.get.
      return call({ ...ticket.command, idempotencyKey: `restore_review_${ticketId}` });
    }
  };
}
