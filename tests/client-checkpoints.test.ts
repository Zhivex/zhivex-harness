import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness } from '../src/runtime/harness.js';
import { createHarnessClientAdapter } from '../src/client/adapter.js';

test('client checkpoint review restores into a derivative and reconnects without duplicating effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'client-checkpoints-'));
  const create = () => createHarness({ workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel({
    streamEvents: [[{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  let harness = await create(), adapter = await createHarnessClientAdapter(harness);
  let hello = adapter.negotiate([1]);
  let seq = 0;
  const call = async (command: Record<string, unknown>): Promise<any> => {
    if (!hello.ok) throw new Error('negotiation');
    return adapter.dispatch({ protocolVersion: 1, requestId: String(++seq), connectionId: hello.connectionId,
      command: { ...command, projectId: hello.projectId } });
  };
  const success = async (command: Record<string, unknown>) => { const result = await call(command); expect(result.ok).toBe(true); return result.data; };
  try {
    await writeFile(path.join(root, 'a.txt'), 'original');
    const created = await success({ method: 'session.create', idempotencyKey: 'create' });
    const run = await success({ method: 'run.start', sessionId: created.session.sessionId, expectedRevision: created.session.revision,
      idempotencyKey: 'run', prompt: 'complete' });
    const source = run.session;
    const common = { sessionId: source.sessionId, expectedRevision: source.revision };
    const captured = await success({ method: 'checkpoint.capture', ...common, idempotencyKey: 'capture', turnId: source.runs[0].turnId, paths: ['a.txt'] });
    const checkpointId = captured.inspection.checkpoint.id;
    await writeFile(path.join(root, 'a.txt'), 'changed');
    const inspected = await success({ method: 'checkpoint.inspect', sessionId: source.sessionId, checkpointId });
    const expected = { 'a.txt': inspected.inspection.files[0].expectedDigest };
    const foreign = await success({ method: 'session.create', idempotencyKey: 'foreign' });
    expect(await call({ method: 'checkpoint.inspect', sessionId: foreign.session.sessionId, checkpointId })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const prepared = await success({ method: 'restore.prepare', ...common, checkpointId, expected, idempotencyKey: 'prepare' });
    expect(prepared.preview.status).toBe('available');
    expect(prepared.preview.diff.files[0]).toMatchObject({ before: 'changed', after: 'original' });
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('changed');
    const apply = { method: 'restore.apply', ...common, operationId: prepared.operation.id, idempotencyKey: 'apply', reviewedProposalId: prepared.operation.proposalId };
    expect(await call({ ...apply, idempotencyKey: 'wrong', reviewedProposalId: `sha256:${'f'.repeat(64)}` })).toMatchObject({ ok: false });
    expect(await call({ ...apply, idempotencyKey: 'revision', expectedRevision: source.revision + 1 })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    adapter.close(); await harness.close();
    harness = await create(); adapter = await createHarnessClientAdapter(harness); hello = adapter.negotiate([1]);
    const listed = await success({ method: 'checkpoint.list', sessionId: source.sessionId });
    expect(listed.restores[0].id).toBe(prepared.operation.id);
    const complete = await success(apply);
    expect(complete.operation.stage).toBe('completed');
    expect(complete.session.parentSessionId).toBe(source.sessionId);
    expect((await success({ method: 'session.get', sessionId: source.sessionId })).session).toEqual(source);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('original');
    adapter.close(); await harness.close();
    harness = await create(); adapter = await createHarnessClientAdapter(harness); hello = adapter.negotiate([1]);
    const replay = await success(apply);
    expect(replay.session.sessionId).toBe(complete.session.sessionId);
    expect((await success({ method: 'session.list' })).sessions.filter((s: any) => s.parentSessionId === source.sessionId)).toHaveLength(1);
  } finally { adapter.close(); await harness.close(); await rm(root, { recursive: true, force: true }); }
});
