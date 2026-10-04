// Copied into an installed consumer. All engine imports resolve its exact tarball.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, runHarness, openHarnessProjectMemory } from '@zhivex-ai/harness/engine';

const script = fileURLToPath(import.meta.url);
const phase = process.argv[2];
const root = path.join(process.cwd(), '.memory-journey');
const state = path.join(root, '.state');
const scope = { tenantId: 'local', userId: 'alice', namespace: 'explicit-shared-scope' };
if (['request', 'seed-legacy', 'legacy-snapshot'].includes(phase)) {
  const expected = process.argv[3], disabled = process.argv[4] === 'disabled';
  let observed = false;
  const model = { provider: 'memory-offline-fixture', modelId: 'fixture',
    capabilities: { streaming: true, tools: true, structuredOutput: true, jsonMode: true,
      toolChoice: true, parallelToolCalls: false, vision: false, files: false, audioInput: false,
      audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
    async generate() { throw new Error('Unexpected generate'); },
    async stream(input) {
      const all = JSON.stringify(input.messages);
      const context = input.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message)).join('\n');
      const system = input.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message)).join('\n');
      assert(!system.includes('remembered migration'), 'Memory entered system authority');
      if (phase === 'request') {
        if (expected === 'absent') assert(!context.includes('remembered migration'), 'Forgotten/disabled memory reached a new request');
        else assert(context.includes(expected), 'Relevant cross-session memory is missing');
        assert(!all.includes('legacy capture sentinel'), 'Legacy SDK memory reached curated or disabled mode');
      }
      observed = true;
      return (async function* () { yield { type: 'text-delta', textDelta: phase === 'seed-legacy' ? 'legacy capture sentinel' : 'offline-memory-ok' }; yield { type: 'finish', finishReason: 'stop' }; })();
    } };
  globalThis.fetch = async () => { throw new Error('Network is disabled for this journey'); };
  const harness = await createHarness({ workspace: root, stateDirectory: state, userId: scope.userId,
    namespace: scope.namespace, modelInstance: model, subagentProfiles: [], ...(phase === 'request' ? { projectMemory: !disabled } : {}) });
  try {
    if (phase === 'legacy-snapshot') {
      const stored = await harness.persistence.memory.load({ runId: 'snapshot', agentId: harness.agent.id, scope: harness.config.scope });
      console.log(JSON.stringify(stored));
    } else {
      const result = await runHarness(harness, { prompt: 'Inspect sqlite migrations' });
      assert.equal(result.status, 'completed'); assert(observed);
      assert(!JSON.stringify(result.state.messages).includes('remembered migration'), 'Ephemeral projection persisted in history');
      console.log(JSON.stringify({ status: 'passed', phase }));
    }
  } finally { await harness.close(); }
} else {
  await mkdir(root, { recursive: true }); const other = path.join(root, 'other'); await mkdir(other, { recursive: true });
  const entries = [path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@zhivex-ai/harness/engine'))), '../cli.js'),
    path.join(path.dirname(fileURLToPath(import.meta.resolve('@zhivex-ai/code/package.json'))), 'dist/cli.js')];
  const locator = ['--workspace', root, '--state-dir', state, '--namespace', scope.namespace, '--user', scope.userId];
  const run = (args, failure = false, extraEnv = {}) => {
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ZHIVEX_HARNESS_CREDENTIAL_STORE: 'disabled', ...extraEnv }, encoding: 'utf8', timeout: 30000 });
    if (failure) assert.notEqual(result.status, 0); else assert.equal(result.status, 0, result.stderr);
    return failure ? undefined : JSON.parse(result.stdout);
  };
  const command = (entry, args, extra = locator, failure = false) => run([entry, 'memory', ...args, ...extra], failure).result;
  const preload = path.join(root, 'memory-cli-fetch.mjs');
  await writeFile(preload, `import assert from 'node:assert/strict';
globalThis.fetch = async (url, options) => {
  assert(String(url).startsWith('https://api.openai.com/v1/'), 'Unexpected offline endpoint');
  assert(!options.body.includes('legacy capture sentinel'), 'CLI opt-out loaded SDK memory');
  assert(!options.body.includes('remembered migration'), 'CLI opt-out loaded curated memory');
  const stream = new ReadableStream({ start(controller) {
    const send = event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\\n\\n'));
    if (process.env.MEMORY_CLI_PHASE === 'waiting') {
      send({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', id: 'fc_memory', call_id: 'call_memory', name: 'apply_reviewed_edits', arguments: JSON.stringify({ changes: [{ path: 'never-written.txt', expectedDigest: null, content: 'fixture' }] }) } });
    } else send({ type: 'response.output_text.delta', delta: 'offline opt-out CLI response' });
    send({ type: 'response.completed', response: { id: 'resp_memory', status: 'completed', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
    controller.close();
  } });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
};`);
  const cli = (entry, args, phase) => run(['--import', preload, entry, ...args, ...locator, '--no-memory', '--json'], false,
    { OPENAI_API_KEY: 'memory-offline-fixture', MEMORY_CLI_PHASE: phase, ZHIVEX_HARNESS_CONFIG_DIR: path.join(root, 'config') });
  run([script, 'seed-legacy']);
  const legacy = run([script, 'legacy-snapshot']);
  assert(JSON.stringify(legacy).includes('legacy capture sentinel'));
  for (const entry of entries) {
    const note = command(entry, ['remember', 'sqlite remembered migration v1', '--source', 'Explicit operator fixture']);
    assert.equal(command(entry, ['read', note.id]).revision, 1);
    run([script, 'request', 'remembered migration v1']);
    command(entry, ['update', note.id, '1', 'sqlite remembered migration v2']);
    run([script, 'request', 'remembered migration v2']);
    const isolated = command(entry, ['list'], ['--workspace', other, '--state-dir', state, '--namespace', scope.namespace, '--user', scope.userId]);
    assert.equal(isolated.entries.length, 0);
    assert.equal(command(entry, ['list'], [...locator.slice(0, -1), 'bob']).entries.length, 0);
    const proposal = command(entry, ['suggest', 'sqlite pending suggestion']);
    assert(!command(entry, ['context', 'sqlite']).ids.includes(proposal.id));
    command(entry, ['accept', proposal.id, '1']);
    assert(command(entry, ['context', 'sqlite']).ids.includes(proposal.id));
    command(entry, ['disable']); run([script, 'request', 'absent']); command(entry, ['enable']);
    run([script, 'request', 'absent', 'disabled']);
    assert.deepEqual(run([script, 'legacy-snapshot']), legacy, 'Engine opt-out overwrote SDK memory');
    const waiting = cli(entry, ['run', 'sqlite MEMORY_EDIT_FIXTURE', '--provider', 'openai', '--model', 'gpt-5.6-luna'], 'waiting');
    assert.equal(waiting.status, 'waiting_approval');
    assert.deepEqual(run([script, 'legacy-snapshot']), legacy, 'CLI run opt-out overwrote SDK memory');
    const resumed = cli(entry, ['resume', waiting.runId, '--deny'], 'resume');
    assert.equal(resumed.status, 'completed');
    assert.deepEqual(run([script, 'legacy-snapshot']), legacy, 'CLI resume opt-out overwrote SDK memory');
    command(entry, ['forget', note.id, '2']); run([script, 'request', 'absent']);
    command(entry, ['clear']); assert.equal(command(entry, ['list']).entries.length, 0);
  }
  // The active row has no retained revisions or deleted content after both CLIs.
  const memory = await openHarnessProjectMemory({ workspace: root, stateDirectory: state, scope });
  try { assert.equal(memory.list().entries.length, 0); } finally { memory.close(); }
  console.log(JSON.stringify({ status: 'passed', offline: true, journeys: ['Harness and Code commands', 'cross-process session retrieval',
    'restart', 'edit', 'forget', 'project and user isolation', 'reviewed suggestions', 'engine and CLI run/resume opt-out with legacy rows', 'clear'] }));
}
