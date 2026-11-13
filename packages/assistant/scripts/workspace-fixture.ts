/** Isolated real-host fixture shared by browser and native workspace smoke checks. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost } from '../src/host.js';
import { startAssistantWeb } from '../src/web/server.js';
import { nativeProjectSelection } from '../src/native-selection.js';

export async function workspaceFixture(native = false) {
  const root = await mkdtemp('/tmp/workspace-smoke-');
  const repo = root + '/sample-project'; await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  await writeFile(repo + '/README.md', '# Sample project\n\nA safe workspace fixture.\n');
  await writeFile(repo + '/hello.ts', 'export const greeting = "Hello workspace";\n');
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: 'tool-call', toolCall: { id: 'read', name: 'read_file', input: { path: 'README.md', startLine: 1, endLine: 20 } } }, { type: 'finish', finishReason: 'tool-calls' }],
    [{ type: 'text-delta', textDelta: 'I inspected the project. ' }, { type: 'text-delta', textDelta: 'See [README.md](README.md#L2) for details. ' }, { type: 'text-delta', textDelta: 'Workspace ready.' }, { type: 'finish', finishReason: 'stop' }],
  ] });
  const original = model.stream!; let calls = 0;
  model.stream = async input => { const events = ++calls <= 2 ? await original(input) : (async function* () { await new Promise(resolve => setTimeout(resolve, 5000)); yield { type: 'text-delta' as const, textDelta: 'Follow-up response.' }; yield { type: 'finish' as const, finishReason: 'stop' as const }; })(); return (async function* () { for await (const event of events) { await new Promise(resolve => setTimeout(resolve, 700)); yield event; } })(); };
  const host = await startAssistantHost({ directory: root + '/state', ownerId: 'workspace-smoke', engine: { modelInstance: model, model: 'workspace-offline-fixture' }, coding: { execution: 'local', configurationId: 'workspace-smoke-v1' } });
  const selection = native ? nativeProjectSelection(process.stdin, process.stdout, () => void close().then(() => process.exit(0))) : undefined;
  const web = await startAssistantWeb(host, { assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)), chooseProject: selection ? selection.choose : async () => repo });
  async function close() { await web.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  return { ...web, repo, root, close };
}
if (process.argv.includes('--native')) {
  const fixture = await workspaceFixture(true);
  await writeFile('/tmp/tauri-stage2/native-fixture.json', JSON.stringify({ repo: fixture.repo, url: fixture.url }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ url: fixture.url }) + '\n');
  process.stdin.resume();
}
