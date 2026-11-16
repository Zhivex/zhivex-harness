import {test, expect} from 'bun:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {createHarness} from '../packages/core/src/runtime/harness.js';
import {startHarnessLocalService} from '../packages/core/src/client/local-service.js';
import {connectApplication} from '../packages/core/src/application/client.js';
import {parseCliArgs} from '../packages/core/src/cli/arguments.js';

test('shared checkpoint CLI binds the source conversation and rejects local runtime flags', () => {
  expect(parseCliArgs(['checkpoints', 'list', 'source', '--area', 'code'])).toMatchObject({applicationArea: 'code'});
  expect(parseCliArgs(['checkpoints', 'apply', 'operation', 'digest', '--area', 'code', '--session', 'source'])).toMatchObject({sessionId: 'source'});
  for (const args of [['inspect', 'checkpoint'], ['storage', '--session', 'source'], ['list', 'source', '--session', 'other'], ['list', 'source', '--workspace', '/tmp/repo']]) {
    expect(() => parseCliArgs(['checkpoints', ...args, '--area', 'code'])).toThrow();
  }
});

test('CLI checkpoints share live host state, preserve reviewed bytes, reject foreign sessions and restore exactly once', async () => {
  const root = await mkdtemp('/tmp/zhx-shared-checkpoints-');
  const harness = await createHarness({workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel({streamEvents: [[{type: 'text-delta', textDelta: 'Done'}, {type: 'finish', finishReason: 'stop'}]]})});
  const service = await startHarnessLocalService(harness, {directory: root + '/socket'});
  const client = await connectApplication(service.credentialsPath);
  const command = async (value: Record<string, unknown>): Promise<any> => {
    const result = await client.command(value); if (!result.ok) throw new Error(result.error.code); return result.data;
  };
  const cli = async (args: string[], sessionId?: string, expected = 0) => {
    const child = Bun.spawn([...(process.env.ZHX_CLI_TEST_ENTRY ? ['node', process.env.ZHX_CLI_TEST_ENTRY] : [process.execPath, '--no-env-file', 'packages/core/src/cli.ts']), 'checkpoints', ...args, '--service', service.credentialsPath, ...(sessionId ? ['--session', sessionId] : []), '--json'], {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected); if (expected) return undefined; expect(stderr).toBe(''); return JSON.parse(stdout);
  };
  try {
    await writeFile(root + '/a.txt', 'original');
    const {session: created} = await command({method: 'session.create', idempotencyKey: 'create'});
    const {session} = await command({method: 'run.start', sessionId: created.sessionId, expectedRevision: created.revision, idempotencyKey: 'run', prompt: 'finish'});
    const {session: foreign} = await command({method: 'session.create', idempotencyKey: 'foreign'});
    const checkpoint = await cli(['capture', session.sessionId, session.runs[0].turnId, 'a.txt']);
    const checkpointId = checkpoint.inspection.checkpoint.id;
    expect((await command({method: 'checkpoint.list', sessionId: session.sessionId})).checkpoints[0].id).toBe(checkpointId);
    await cli(['inspect', checkpointId], foreign.sessionId, 1);
    await writeFile(root + '/a.txt', 'changed');
    const review = await cli(['prepare', checkpointId], session.sessionId);
    await cli(['prune-review', `checkpoint:${checkpointId}`, `restore:${review.operationId}`], undefined, 1);
    expect(review.diff.files[0]).toMatchObject({before: 'changed', after: 'original'});
    expect(await readFile(root + '/a.txt', 'utf8')).toBe('changed');
    await cli(['apply', review.operationId, 'sha256:' + '0'.repeat(64)], session.sessionId, 1);
    await writeFile(root + '/a.txt', 'foreign edit');
    await cli(['apply', review.operationId, review.reviewedProposalId], session.sessionId, 1);
    expect(await readFile(root + '/a.txt', 'utf8')).toBe('foreign edit');
    expect((await cli(['review', review.operationId], session.sessionId)).previewStatus).toBe('unavailable');
    await writeFile(root + '/a.txt', 'changed');
    const restored = await cli(['apply', review.operationId, review.reviewedProposalId], session.sessionId);
    expect(restored.session.parentSessionId).toBe(session.sessionId);
    expect(await readFile(root + '/a.txt', 'utf8')).toBe('original');
    expect((await cli(['apply', review.operationId, review.reviewedProposalId], session.sessionId)).session.sessionId).toBe(restored.session.sessionId);
    expect((await cli(['list', session.sessionId])).restores).toHaveLength(1);
    expect((await command({method: 'session.list'})).sessions).toHaveLength(3);
    const selection = [`checkpoint:${checkpointId}`, `restore:${review.operationId}`];
    expect((await cli(['storage'])).records).toBe(2);
    await cli(['prune-review', `checkpoint:${checkpointId}`], undefined, 1);
    const plan = await cli(['prune-review', ...selection]);
    expect(plan).toMatchObject({recordsBefore: 2, recordsAfter: 0, workspaceFilesChanged: false, conversationsChanged: false});
    await cli(['prune-apply', 'sha256:' + '0'.repeat(64), ...selection], undefined, 1);
    // A new checkpoint changes the inventory even when the selected IDs are unchanged.
    const extra = await cli(['capture', session.sessionId, session.runs[0].turnId, 'a.txt']);
    await cli(['prune-apply', plan.planId, ...selection], undefined, 1);
    expect((await cli(['storage'])).records).toBe(3);
    const fresh = await cli(['prune-review', ...selection]);
    expect((await cli(['prune-apply', fresh.planId, ...selection])).kind).toBe('checkpoint-pruned');
    expect((await cli(['storage'])).records).toBe(1);
    expect((await cli(['list', session.sessionId])).checkpoints[0].id).toBe(extra.inspection.checkpoint.id);
    expect(await readFile(root + '/a.txt', 'utf8')).toBe('original');
    expect((await command({method: 'session.list'})).sessions).toHaveLength(3);

  } finally {await service.close(); await harness.close(); await rm(root, {recursive: true, force: true});}
}, 30000);
