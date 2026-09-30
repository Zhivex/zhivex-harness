import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHarness, openCliSessionStore, openWorkspaceCheckpointStore } from '@zhivex-ai/harness/engine';
import { createHarnessClientAdapter } from '@zhivex-ai/harness/client';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { installedHarness } from './installed-harness.js';

const candidate = await installedHarness(path.resolve(import.meta.dir, '..'));
const directory = await mkdtemp('/tmp/har-checkpoint-cli-'), workspace = path.join(directory, 'repo');
await Bun.write(path.join(workspace, 'a.txt'), 'original');
const harness = await createHarness({ workspace, stateDirectory: path.join(directory, 'state'), subagentProfiles: [], modelInstance: createMockLanguageModel({ provider: 'openai', modelId: 'gpt-6-luna', streamEvents: [[
  { type: 'text-delta', textDelta: 'fixture complete' }, { type: 'finish', finishReason: 'stop' }
]] }) });
const adapter = await createHarnessClientAdapter(harness);
const hello = adapter.negotiate([1]); assert(hello.ok);
let seq = 0;
const call = async (command: Record<string, unknown>): Promise<any> => {
  const result = await adapter.dispatch({ protocolVersion: 1, requestId: String(++seq), connectionId: hello.connectionId,
    command: { ...command, projectId: hello.projectId } }); assert(result.ok); return result.data;
};
try {
  const created = await call({ method: 'session.create', idempotencyKey: 'create' });
  const done = await call({ method: 'run.start', sessionId: created.session.sessionId, expectedRevision: created.session.revision, idempotencyKey: 'run', prompt: 'finish' });
  const session = done.session;
  const captured = await call({ method: 'checkpoint.capture', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'capture', turnId: session.runs[0].turnId, paths: ['a.txt'] });
  await writeFile(path.join(workspace, 'a.txt'), 'changed');
  const inspected = await call({ method: 'checkpoint.inspect', sessionId: session.sessionId, checkpointId: captured.inspection.checkpoint.id });
  const prepared = await call({ method: 'restore.prepare', sessionId: session.sessionId, checkpointId: captured.inspection.checkpoint.id, expectedRevision: session.revision,
    idempotencyKey: 'prepare', expected: { 'a.txt': inspected.inspection.files[0].expectedDigest } });
  adapter.close(); await harness.close();
  const cli = path.join(candidate.nodeModules, '@zhivex-ai/harness/dist/cli.js');
  const spec = path.join(directory, 'pty.json');
  await writeFile(spec, JSON.stringify({ command: [process.env.HARNESS_NODE_BINARY ?? '/tmp/zhx-runtime-matrix/node-v22.13.0-darwin-arm64/bin/node', cli,
    'checkpoints', 'apply', prepared.operation.id, prepared.operation.proposalId, '--workspace', workspace, '--state-dir', harness.config.stateDirectory],
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, TERM: 'xterm-256color', OPENAI_API_KEY: 'fixture-not-a-real-credential' },
    expectedTitle: `restore:${prepared.operation.id}`, transcript: path.join(directory, 'transcript.txt') }));
  const child = Bun.spawn(['python3', path.join(import.meta.dir, 'checkpoint-cli-pty.py'), spec], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `${directory}\n${stderr}`);
  const sessions = await openCliSessionStore({ workspace, stateDirectory: harness.config.stateDirectory, scope: harness.config.scope });
  const checkpoints = await openWorkspaceCheckpointStore(harness.workspace, sessions);
  try {
    const operation = checkpoints.getOperation(prepared.operation.id); assert.equal(operation.stage, 'completed');
    assert.deepEqual(await sessions.get(session.sessionId), session);
    const derivative = await sessions.get(operation.forkSessionId!); assert(derivative); assert.equal(derivative.runs.length, 1);
    assert.equal((await sessions.list()).filter(value => value.parentSessionId === session.sessionId).length, 1);
    assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), 'original');
    const evidence = { ...JSON.parse(stdout), artifactSha256: candidate.sha256, runtime: 'Node 22.13.0', fixture: true,
      originalPreserved: true, singleDerivative: true, noAdditionalRun: true, evidenceDirectory: directory };
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
  } finally { checkpoints.close(); sessions.close(); }
} finally { adapter.close(); await harness.close(); }
