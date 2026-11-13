/** Adapted from Desktop's trusted review host; the renderer receives no dispatch authority. */
import { z } from 'zod';
import type { AssistantConversationBinding, AssistantReviewTarget, AssistantReviewReceipt } from '../application-contracts.js';
import type { connectAssistant, AssistantCommand } from '../client.js';
import type { HarnessClientResponse } from '@zhivex-ai/harness/protocol';
import { projectApprovalReview } from './approval-review.js';
import { ReviewTickets } from './review-tickets.js';
import { createCheckpointReviewHost } from './checkpoint-review.js';
type Owner = { client: Awaited<ReturnType<typeof connectAssistant>> };
const id = z.string().min(1).max(256);
const target = z.discriminatedUnion('kind', [z.object({ kind: z.literal('effect'), runId: id }).strict(), z.object({ kind: z.literal('restore'), operationId: z.string().uuid() }).strict(), z.object({ kind: z.literal('restore-recovery'), operationId: z.string().uuid(), forkSessionId: id }).strict()]);
export function createWorkspaceReview(find: (id: string) => Promise<{ binding: AssistantConversationBinding; owner: Owner }>, redact: (text: string) => string) {
  const tickets = new Map<string, { conversationId: string; resolve(approve: boolean): Promise<HarnessClientResponse> }>();
  const scope = async (conversationId: string) => { const result = await find(conversationId); if (result.binding.context.kind !== 'project') throw new Error('CAPABILITY_UNAVAILABLE'); return result; };
  const clean = <T>(value: T): T => {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map(item => clean(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) as T;
    return value;
  };
  const read = async (owner: Owner, command: AssistantCommand) => { const result = await owner.client.command(command); if (!result.ok) throw new Error(result.error.code); return result.data; };
  const receipt = (value: AssistantReviewReceipt, resolve: (approve: boolean) => Promise<HarnessClientResponse>) => { tickets.set(value.ticketId, { conversationId: value.conversationId, resolve }); while (tickets.size > 128) tickets.delete(tickets.keys().next().value!); return value; };
  return {
    async review(input: { conversationId: string; target: AssistantReviewTarget }): Promise<AssistantReviewReceipt> {
      const value = z.object({ conversationId: id, target }).strict().parse(input);
      const { owner, binding } = await scope(value.conversationId), sessionId = binding.sessionId;
      if (value.target.kind === 'effect') {
        const data = await read(owner, { method: 'run.get', sessionId, runId: value.target.runId, includeReview: true });
        if (data.kind !== 'run') throw new Error('REVIEW_STALE');
        const authority = new ReviewTickets();
        const review = authority.issue(sessionId, projectApprovalReview(data.run, redact));
        return receipt({ ticketId: review.ticketId, conversationId: value.conversationId, target: value.target, expiresAt: Math.min(Date.now() + 300000, ...review.items.map(item => item.expiresAt)), preview: { kind: 'effect', review } }, async approve => {
          const command = authority.consume(review.ticketId, approve);
          // Reproject immediately before dispatch. The engine additionally checks revision,
          // approval digest and filesystem preconditions under its mutation admission lock.
          const fresh = await read(owner, { method: 'run.get', sessionId, runId: review.runId, includeReview: true });
          if (fresh.kind !== 'run' || JSON.stringify(projectApprovalReview(fresh.run, redact)) !== JSON.stringify(projectApprovalReview(data.run, redact))) throw new Error('REVIEW_STALE');
          return owner.client.reviewed(command);
        });
      }
      const authority = createCheckpointReviewHost(command => owner.client.command(command as AssistantCommand), clean);
      const review = value.target.kind === 'restore' ? await authority.review(sessionId, value.target.operationId) : await authority.reviewRecovery(sessionId, value.target.operationId, value.target.forkSessionId);
      return receipt({ ticketId: review.ticketId, conversationId: value.conversationId, target: value.target, expiresAt: review.expiresAt, preview: { kind: 'restore', review } }, async approve => (await authority.resolve(review.ticketId, approve)) ?? { protocolVersion: 1, requestId: null, ok: true, data: await read(owner, { method: 'session.get', sessionId }) });
    },
    async decide(input: { conversationId: string; ticketId: string; approve: boolean; idempotencyKey: string }) {
      const value = z.object({ conversationId: id, ticketId: z.string().uuid(), approve: z.boolean(), idempotencyKey: id }).strict().parse(input);
      const ticket = tickets.get(value.ticketId);
      if (!ticket || ticket.conversationId !== value.conversationId) throw new Error('REVIEW_STALE');
      tickets.delete(value.ticketId); // Consume before I/O: ambiguous effects are never replayed.
      await scope(value.conversationId);
      return ticket.resolve(value.approve);
    },
    async inspect(input: unknown) {
      const value = z.object({ conversationId: id, runId: id, offset: z.number().int().min(0).max(512).default(0) }).strict().parse(input);
      const { owner, binding } = await scope(value.conversationId);
      const result = await read(owner, { method: 'run.get', sessionId: binding.sessionId, runId: value.runId, includeDiff: true, decisionOffset: value.offset });
      if (result.kind !== 'run') throw new Error('REVIEW_STALE');
      return clean({ decisions: result.run.decisions ?? [], total: result.run.decisionTotal ?? 0, nextOffset: result.run.decisionNextOffset });
    },
    async action(input: unknown) {
      const value = z.object({ conversationId: id, command: z.record(z.string(), z.unknown()) }).strict().parse(input);
      const { owner, binding } = await scope(value.conversationId);
      const allowed = ['checkpoint.list', 'checkpoint.inspect', 'checkpoint.capture', 'restore.prepare', 'restore.get', 'task.start', 'task.get', 'task.review', 'task.keep', 'task.revise', 'task.continue'];
      if (!allowed.includes(String(value.command.method)) || 'projectId' in value.command || 'sessionId' in value.command) throw new Error('INVALID_REQUEST');
      // The ordinary engine protocol validates every field, revision and run membership.
      const response = await owner.client.command({ ...value.command, sessionId: binding.sessionId } as AssistantCommand);
      if (response.ok && response.data.kind === 'run') { const { run, session } = response.data; return clean({ ...response, data: { kind: 'run' as const, session, run: { runId: run.runId, revision: run.revision, status: run.status, output: run.output, approvals: [] } } }); }
      const result = clean(response);
      if (result.ok && result.data.kind === 'taskReview' && JSON.stringify(result) !== JSON.stringify(response)) { result.data.review.complete = false; result.data.review.canKeep = false; result.data.review.canContinue = false; result.data.review.canRevise = false; }
      return result;
    }
  };
}
