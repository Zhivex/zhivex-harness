// Copied into a clean consumer by smoke-engine-code.mjs. No repository or SDK test imports.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
// Historical packages predate /engine; use their declared root API explicitly.
const { createHarness, runHarness, openCliSessionStore } = await import(process.env.HARNESS_COMPAT_ROOT === '1'
  ? '@zhivex-ai/harness' : '@zhivex-ai/harness/engine');

const phase = process.argv[2];
if (phase === 'session-create' || phase === 'session-inspect') {
  const sessions = await openCliSessionStore({ workspace: process.cwd(),
    stateDirectory: path.join(process.cwd(), '.state'), scope: { tenantId: 'local', namespace: 'upgrade-sessions' } });
  try {
    if (phase === 'session-create') {
      const session = await sessions.create({ initialRun: {
        runId: 'historical-session-run', provider: 'openai', model: 'fixture', status: 'completed' } });
      await writeFile('session-before.json', JSON.stringify(session));
    } else {
      const before = JSON.parse(await readFile('session-before.json', 'utf8'));
      assert.deepEqual(await sessions.get(before.sessionId), before, 'Historical session metadata changed');
      assert((await sessions.list()).some(session => session.sessionId === before.sessionId));
    }
  } finally { sessions.close(); }
  console.log(`INSTALLED_${phase.toUpperCase()}_OK`);
} else {
const capabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true,
  toolChoice: true, parallelToolCalls: false, vision: false, files: false, audioInput: false,
  audioOutput: false, embeddings: false, reasoning: false, webSearch: false };
const finish = { type: 'finish', finishReason: 'stop' };
const controller = new AbortController();
const model = { provider: 'installed-fixture', modelId: 'fixture', capabilities,
  async generate() { throw new Error('Unexpected non-streaming request'); },
  async stream() {
    assert.notEqual(phase, 'reject-incompatible', 'Incompatible approval must not contact the model');
    return (async function* () {
    if (phase === 'cancel') { controller.abort(); throw new DOMException('fixture cancelled', 'AbortError'); }
    if (phase === 'create') {
      yield { type: 'tool-call', toolCall: { id: 'installed-write', name: 'apply_reviewed_edits',
        input: { changes: [{ path: 'approved.txt', expectedDigest: null, content: 'approved-installed-write\n' }] } } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    } else { yield { type: 'text-delta', textDelta: 'installed-resume-ok' }; yield finish; }
  })(); }
};
const harness = await createHarness({ provider: 'openai', workspace: process.cwd(),
  stateDirectory: path.join(process.cwd(), '.state'), modelInstance: model, subagentProfiles: [] });
try {
  if (phase === 'create') {
    const waiting = await runHarness(harness, { prompt: 'Create approved.txt with the requested content' });
    assert.equal(waiting.status, 'waiting_approval');
    assert(waiting.state.pendingApprovals.length > 0);
    await assert.rejects(readFile('approved.txt'));
    await writeFile('run-id.json', JSON.stringify(waiting.state.runId));
  } else if (phase === 'resume') {
    const runId = JSON.parse(await readFile('run-id.json', 'utf8'));
    const state = await harness.store.load(runId, harness.config.scope);
    assert.equal(state?.status, 'waiting_approval');
    const completed = await runHarness(harness, { state, approvals: state.pendingApprovals.map(a => ({
      provider: a.provider, approvalRequestId: a.id, approve: true })) });
    assert.equal(completed.status, 'completed');
    assert.equal(await readFile('approved.txt', 'utf8'), 'approved-installed-write\n');
    assert.equal((await harness.store.load(runId, harness.config.scope))?.status, 'completed');
  } else if (phase === 'inspect-compatible') {
    const runId = JSON.parse(await readFile('run-id.json', 'utf8'));
    const state = await harness.store.load(runId, harness.config.scope);
    assert.equal(state?.status, 'waiting_approval');
    assert.deepEqual(state.harness, harness.agent.harness, 'Compatible identity must match without rewriting');
    assert(state.pendingApprovals.length > 0);
    await assert.rejects(readFile('approved.txt'));
  } else if (phase === 'reject-incompatible') {
    const runId = JSON.parse(await readFile('run-id.json', 'utf8'));
    const state = await harness.store.load(runId, harness.config.scope);
    assert.equal(state?.status, 'waiting_approval');
    const before = JSON.stringify(state);
    await assert.rejects(runHarness(harness, { state, approvals: state.pendingApprovals.map(a => ({
      provider: a.provider, approvalRequestId: a.id, approve: true })) }), /different harness fingerprint/);
    await assert.rejects(readFile('approved.txt'));
    assert.equal(JSON.stringify(await harness.store.load(runId, harness.config.scope)), before,
      'Rejected migration must preserve the historical pending run');
  } else if (phase === 'cancel') {
    const result = await runHarness(harness, { prompt: 'Cancel this execution', abortSignal: controller.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal((await harness.store.load(result.state.runId, harness.config.scope))?.status, 'cancelled');
  } else throw new Error(`Unknown phase ${phase}`);
  console.log(`INSTALLED_ENGINE_${phase.toUpperCase()}_OK`);
} finally { await harness.close(); }

}
