import { expect, test } from 'bun:test';
import type { HarnessClientData, HarnessClientResponse } from '@zhivex-ai/harness/protocol';
import { createCheckpointReviewHost } from '../src/checkpoint-review.js';

function fixture(redact: (value: unknown) => unknown = value => value) {
  const calls: Record<string, unknown>[] = [];
  let time = 1000;
  let operation: Extract<HarnessClientData, { kind: 'restore' }> = {
    kind: 'restore', operation: { id: 'operation', checkpointId: 'checkpoint', stage: 'prepared', proposalId: 'sha256:reviewed' },
    preview: { status: 'available', diff: { proposalId: 'sha256:reviewed', files: [{ path: 'a.txt', before: 'changed', after: 'original', expectedDigest: 'sha256:before', afterDigest: 'sha256:after' }] } }
  };
  const call = async (command: Record<string, unknown>): Promise<HarnessClientResponse> => {
    calls.push(command);
    const data = command.method === 'session.get' ? { kind: 'session', session: { sessionId: command.sessionId, revision: 7 } } : operation;
    return { protocolVersion: 1, requestId: 'test', ok: true, data: data as HarnessClientData };
  };
  return { calls, host: createCheckpointReviewHost(call, redact, () => time), expire: () => { time += 16 * 60_000; }, setOperation: (value: typeof operation) => { operation = value; } };
}

test('confirmation uses the host revision and proposal, rejects invented or consumed tickets', async () => {
  const f = fixture();
  const view = await f.host.review('source', 'operation');
  view.operation.proposalId = 'sha256:renderer-tamper';
  await expect(f.host.resolve('invented', true)).rejects.toThrow('REVIEW_REQUIRED');
  await f.host.resolve(view.ticketId, true);
  expect(f.calls.at(-1)).toMatchObject({ method: 'restore.apply', sessionId: 'source', operationId: 'operation',
    expectedRevision: 7, reviewedProposalId: 'sha256:reviewed' });
  await expect(f.host.resolve(view.ticketId, true)).rejects.toThrow('REVIEW_REQUIRED');
});

test('cancelled, expired or redacted reviews never admit a restore', async () => {
  const f = fixture();
  const cancelled = await f.host.review('source', 'operation');
  expect(await f.host.resolve(cancelled.ticketId, false)).toBeNull();
  const expired = await f.host.review('source', 'operation'); f.expire();
  await expect(f.host.resolve(expired.ticketId, true)).rejects.toThrow('REVIEW_EXPIRED');
  expect(f.calls.some(command => command.method === 'restore.apply')).toBe(false);
  const hidden = fixture(value => JSON.parse(JSON.stringify(value).replace('original', '[REDACTED]')));
  const review = await hidden.host.review('source', 'operation');
  expect(review.redacted).toBe(true); expect(review.canApply).toBe(false);
  await expect(hidden.host.resolve(review.ticketId, true)).rejects.toThrow('REVIEW_INCOMPLETE');
  expect(hidden.calls.some(command => command.method === 'restore.apply')).toBe(false);
});

test('uncertain transport consumes the ticket before effects can be retried', async () => {
  let attempts = 0;
  const host = createCheckpointReviewHost(async command => {
    if (command.method === 'restore.apply') { attempts++; throw new Error('response lost'); }
    return { protocolVersion: 1, requestId: 'test', ok: true, data: command.method === 'session.get'
      ? { kind: 'session', session: { sessionId: 'source', revision: 1 } }
      : { kind: 'restore', operation: { id: 'operation', checkpointId: 'checkpoint', stage: 'prepared', proposalId: 'reviewed' }, preview: { status: 'available', diff: { proposalId: 'reviewed', files: [{ path: 'a.txt', before: 'before', after: 'after', expectedDigest: 'before', afterDigest: 'after' }] } } } } as HarnessClientResponse;
  }, value => value);
  const review = await host.review('source', 'operation');
  await expect(host.resolve(review.ticketId, true)).rejects.toThrow('response lost');
  await expect(host.resolve(review.ticketId, true)).rejects.toThrow('REVIEW_REQUIRED');
  expect(attempts).toBe(1);
});

test('interrupted fork recovery binds only the exact existing child and requires separate confirmation', async () => {
  const calls: Record<string, unknown>[] = [];
  let matching = false;
  const host = createCheckpointReviewHost(async command => {
    calls.push(command);
    const data = command.method === 'session.get' ? { kind: 'session', session: command.sessionId === 'source'
      ? { sessionId: 'source', revision: 4 } : { sessionId: 'child', parentSessionId: matching ? 'source' : 'foreign', forkedFromTurnId: 'turn', title: 'restore:operation' } }
      : command.method === 'checkpoint.inspect' ? { kind: 'checkpoint', inspection: { checkpoint: { turnId: 'turn' } } }
      : { kind: 'restore', operation: { id: 'operation', checkpointId: 'checkpoint', stage: 'forking', proposalId: 'reviewed' }, preview: { status: 'unavailable' } };
    return { protocolVersion: 1, requestId: 'test', ok: true, data } as HarnessClientResponse;
  }, value => value);
  await expect(host.reviewRecovery('source', 'operation', 'child')).rejects.toThrow('CHECKPOINT_RECOVERY_MISMATCH');
  matching = true;
  const review = await host.reviewRecovery('source', 'operation', 'child');
  expect(review.recoverySessionId).toBe('child'); expect(review.canApply).toBe(true);
  expect(calls.some(command => command.method === 'restore.recoverFork')).toBe(false);
  await host.resolve(review.ticketId, true);
  expect(calls.at(-1)).toMatchObject({ method: 'restore.recoverFork', operationId: 'operation', sessionId: 'source', forkSessionId: 'child', expectedRevision: 4 });
  expect(calls.some(command => command.method === 'restore.apply')).toBe(false);
});

test('completion review accepts already-restored files but rejects a partial filesystem result', async () => {
  let allRestored = false;
  const host = createCheckpointReviewHost(async command => {
    const data = command.method === 'session.get' ? { kind: 'session', session: { sessionId: 'source', revision: 4 } }
      : command.method === 'checkpoint.inspect' ? { kind: 'checkpoint', inspection: { files: [{ status: 'available', expectedDigest: allRestored ? 'after' : 'different', afterDigest: 'after' }] } }
      : { kind: 'restore', operation: { id: 'operation', checkpointId: 'checkpoint', stage: 'applying', proposalId: 'reviewed' }, preview: { status: 'unavailable' } };
    return { protocolVersion: 1, requestId: 'test', ok: true, data } as HarnessClientResponse;
  }, value => value);
  expect((await host.review('source', 'operation')).canApply).toBe(false);
  allRestored = true;
  const review = await host.review('source', 'operation');
  expect(review.completionOnly).toBe(true); expect(review.canApply).toBe(true);
});
