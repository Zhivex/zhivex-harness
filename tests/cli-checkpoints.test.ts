import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness } from '../src/runtime/harness.js';
import { createHarnessClientAdapter } from '../src/client/adapter.js';
import { parseCliArgs } from '../src/cli/arguments.js';

test('checkpoint CLI requires explicit restore identity and rejects unrelated authority options', () => {
  expect(parseCliArgs(['checkpoints', 'apply', 'operation', 'sha256:digest']).checkpointArguments).toEqual(['operation', 'sha256:digest']);
  expect(parseCliArgs(['checkpoints', 'apply', '--help']).helpTopic).toBe('checkpoints:apply');
  expect(() => parseCliArgs(['checkpoints', 'apply', 'operation', '--yes'])).toThrow();
  expect(() => parseCliArgs(['checkpoints', 'list', 'session', '--provider', 'openai'])).toThrow();
  expect(() => parseCliArgs(['checkpoints', 'capture', 'session', 'turn'])).toThrow();
  expect(() => parseCliArgs(['checkpoints', 'constructor', 'session'])).toThrow();
  expect(parseCliArgs(['checkpoints', 'storage']).checkpointArguments).toEqual([]);
  expect(() => parseCliArgs(['checkpoints', 'prune-apply', 'hash'])).toThrow();
  expect(() => parseCliArgs(['checkpoints', 'prune-review', 'checkpoint:id', '--yes'])).toThrow();
});

test('real CLI processes review and restore a persisted checkpoint without a provider or duplicate derivative', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-checkpoints-'));
  const stateDirectory = path.join(root, '.state');
  const harness = await createHarness({ workspace: root, stateDirectory, subagentProfiles: [], modelInstance: createMockLanguageModel({
    streamEvents: [[{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  const adapter = await createHarnessClientAdapter(harness);
  const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error('negotiation');
  let seq = 0;
  const call = async (command: Record<string, unknown>): Promise<any> => {
    const result = await adapter.dispatch({ protocolVersion: 1, requestId: String(++seq), connectionId: hello.connectionId,
      command: { ...command, projectId: hello.projectId } });
    if (!result.ok) throw new Error(result.error.code); return result.data;
  };
  const cli = async (args: string[], expectedCode = 0) => {
    const process = Bun.spawn([Bun.which('bun')!, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'checkpoints', ...args,
      '--workspace', root, '--state-dir', stateDirectory, '--json'], { cwd: root, env: {}, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (expectedCode === 0) { expect(stderr).toBe(''); expect(code).toBe(0); return JSON.parse(stdout); }
    expect(code).not.toBe(0); return undefined;
  };
  try {
    await writeFile(path.join(root, 'a.txt'), 'original');
    const created = await call({ method: 'session.create', idempotencyKey: 'create' });
    const done = await call({ method: 'run.start', sessionId: created.session.sessionId, expectedRevision: created.session.revision,
      idempotencyKey: 'run', prompt: 'finish' });
    const source = done.session;
    adapter.close(); await harness.close();
    const captured = await cli(['capture', source.sessionId, source.runs[0].turnId, 'a.txt']);
    const checkpointId = captured.inspection.checkpoint.id;
    expect((await cli(['list', source.sessionId])).checkpoints[0].id).toBe(checkpointId);
    await writeFile(path.join(root, 'a.txt'), 'changed');
    const prepared = await cli(['prepare', checkpointId]);
    expect(prepared.diff.files[0]).toMatchObject({ before: 'changed', after: 'original' });
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('changed');
    await cli(['apply', prepared.operationId, `sha256:${'0'.repeat(64)}`], 1);
    await writeFile(path.join(root, 'a.txt'), 'foreign edit');
    await cli(['apply', prepared.operationId, prepared.reviewedProposalId], 1);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('foreign edit');
    expect((await cli(['review', prepared.operationId])).previewStatus).toBe('unavailable');
    await writeFile(path.join(root, 'a.txt'), 'changed');
    const reviewed = await cli(['review', prepared.operationId]);
    const completed = await cli(['apply', prepared.operationId, reviewed.reviewedProposalId]);
    expect(completed.session.parentSessionId).toBe(source.sessionId);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('original');
    expect((await cli(['apply', prepared.operationId, reviewed.reviewedProposalId])).session.sessionId).toBe(completed.session.sessionId);
    expect((await cli(['list', source.sessionId])).restores).toHaveLength(1);
    const storage = await cli(['storage']);
    expect(storage).toMatchObject({ automaticEviction: false, records: 2, availableRecords: 98 });
    await cli(['prune-review', `checkpoint:${checkpointId}`], 1);
    const selection = [`checkpoint:${checkpointId}`, `restore:${prepared.operationId}`];
    const removal = await cli(['prune-review', ...selection]);
    expect(removal).toMatchObject({ recordsBefore: 2, recordsAfter: 0, workspaceFilesChanged: false, conversationsChanged: false });
    expect((await cli(['storage'])).records).toBe(2);
    await cli(['prune-apply', `sha256:${'0'.repeat(64)}`, ...selection], 1);
    expect((await cli(['storage'])).records).toBe(2);
    expect((await cli(['prune-apply', removal.planId, ...selection])).kind).toBe('checkpoint-pruned');
    expect((await cli(['storage'])).records).toBe(0);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('original');
  } finally { adapter.close(); await harness.close(); await rm(root, { recursive: true, force: true }); }
});
