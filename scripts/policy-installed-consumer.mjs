// Run only from an isolated installed consumer, never against checkout aliases.
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHarness, runHarness } from '@zhivex-ai/harness/engine';

const phase = process.argv[2];
const policyFile = path.resolve('..', 'policy.json');
const policy = { schemaVersion: 1, rules: [{ id: 'private', tools: ['read_file'], paths: ['private.txt'], decision: 'deny', reason: 'Fixture restriction' }] };
const capabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true,
  toolChoice: true, parallelToolCalls: false, vision: false, files: false, audioInput: false,
  audioOutput: false, embeddings: false, reasoning: false, webSearch: false };
const model = { provider: 'installed-fixture', modelId: 'policy-fixture', capabilities,
  async generate() { throw new Error('Unexpected generate'); },
  async stream() {
    assert.notEqual(phase, 'incompatible', 'Incompatible resume contacted model');
    return (async function* () {
      if (phase === 'prepare') {
        yield { type: 'tool-call', toolCall: { id: 'write', name: 'apply_reviewed_edits', input: { changes: [{ path: 'approved.txt', expectedDigest: null, content: 'approved' }] } } };
        yield { type: 'finish', finishReason: 'tool-calls' };
      } else { yield { type: 'text-delta', textDelta: 'done' }; yield { type: 'finish', finishReason: 'stop' }; }
    })();
  }
};
const options = { workspace: process.cwd(), stateDirectory: path.resolve('..', 'state'), toolPolicyFile: policyFile,
  modelInstance: model, subagentProfiles: ['explorer'] };
if (phase === 'prepare') {
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  await chmod(policyFile, 0o644);
  await assert.rejects(createHarness(options), /private permissions/);
  await chmod(policyFile, 0o600);
  await writeFile(policyFile, JSON.stringify({ ...policy, rules: [{ ...policy.rules[0], tools: ['search_files'] }] }));
  await assert.rejects(createHarness(options), /safely resolve/);
  await writeFile(policyFile, JSON.stringify(policy));
} else if (phase === 'incompatible') {
  await writeFile(policyFile, JSON.stringify({ schemaVersion: 1, rules: [] }));
} else if (phase === 'resume') {
  await writeFile(policyFile, JSON.stringify(policy));
} else throw new Error('Unknown phase');
const harness = await createHarness(options);
try {
  if (phase === 'prepare') {
    await assert.rejects(harness.agent.tools.read_file.execute({ path: 'private.txt' }), /private/);
    await assert.rejects(harness.subagents.get('explorer').tools.read_file.execute({ path: 'private.txt' }), /private/);
    const pending = await runHarness(harness, { prompt: 'Create approved.txt' });
    assert.equal(pending.status, 'waiting_approval');
    await writeFile('run-id.json', JSON.stringify(pending.state.runId));
    await assert.rejects(readFile('approved.txt'));
  } else {
    const runId = JSON.parse(await readFile('run-id.json', 'utf8'));
    const state = await harness.store.load(runId, harness.config.scope);
    assert.equal(state.status, 'waiting_approval');
    const input = { state, approvals: state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) };
    if (phase === 'incompatible') {
      await assert.rejects(runHarness(harness, input), /fingerprint|binding/i);
      await assert.rejects(readFile('approved.txt'));
      assert.deepEqual(await harness.store.load(runId, harness.config.scope), state, 'Incompatible resume must not persist approval intent');
    } else {
      assert.equal((await runHarness(harness, input)).status, 'completed');
      assert.equal(await readFile('approved.txt', 'utf8'), 'approved');
    }
  }
} finally { await harness.close(); }
console.log(JSON.stringify({ phase, ok: true, runtime: process.version }));
