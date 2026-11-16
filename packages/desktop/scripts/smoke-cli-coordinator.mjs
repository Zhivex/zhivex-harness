import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {AsyncEntry} from '@napi-rs/keyring';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, realpath, readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
const core = path.join(installed.install, 'node_modules/@zhivex-ai/harness');
const entry = path.join(core, 'dist/zhx.js');
const {connectCoordinator} = await import(path.join(core, 'dist/engine/application-client.js'));
const directory = await realpath(await mkdtemp('/tmp/zhx-cli-launch-'));
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (JSON.parse(body).stream) {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const value of [{id: 'fixture', choices: [{index: 0, delta: {content: 'CLI managed assistant'}, finish_reason: null}]}, {id: 'fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}]) response.write('data: ' + JSON.stringify(value) + '\n\n');
    response.end('data: [DONE]\n\n');
  } else {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({choices: [{message: {role: 'assistant', content: 'OK'}}]}));}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const invoke = async (args, input = '') => {
  const pending = execute('node', [entry, ...args, '--application-directory', directory, '--json'], {timeout: 40000});
  pending.child.stdin.end(input);
  const {stdout, stderr} = await pending;
  assert(!(stdout + stderr).includes('fixture-cli-provider-key'));
  return JSON.parse(stdout);
};
const cli = async args => JSON.parse((await execute('node', [entry, 'application', ...args, '--application-directory', directory, '--json'], {timeout: 40000})).stdout);
let pid;
try {
  assert.equal((await cli(['status'])).status, 'unavailable');
  const starts = await Promise.all([cli(['start']), cli(['start'])]);
  assert(starts.every(result => result.status === 'running'));
  const database = new Database(path.join(directory, 'setup.sqlite'), {readonly: true});
  pid = database.query('SELECT pid FROM owner WHERE id=1').get().pid; database.close();
  process.kill(pid, 0);
  const command = (await execute('ps', ['-p', String(pid), '-o', 'command='])).stdout;
  assert(command.includes(path.join(core, 'dist/service-cli.js')));
  const client = await connectCoordinator(directory);
  assert.equal((await client.state()).state.configured, false);
  await invoke(['agents', 'create', 'CLI assistant']);
  const connections = await invoke(['connections', 'configure', '-'], JSON.stringify({baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', apiKey: 'fixture-cli-provider-key', allowInsecureLocalhost: true}));
  const connectionId = connections.connections[0].id;
  const tools = await invoke(['agents', 'tools', '-'], JSON.stringify({daily: true, proactive: false}));
  assert.equal(tools.draft.tools.daily, true);
  const first = await invoke(['agents', 'start']); const firstId = first.agents[0].id;
  assert.equal((await invoke(['personal', 'tasks'])).enabled, true);
  assert.equal((await invoke(['personal', 'reminders'])).enabled, true);
  const automation = await invoke(['automations', 'status']);
  assert.equal(automation.available, false); assert.equal(automation.state, null);
  assert.equal(automation.kind, 'application-automation');
  const run = await invoke(['run', '--area', 'assistant', 'Hello from CLI setup']); assert.equal(run.status, 'completed');
  await invoke(['agents', 'create', 'Second CLI assistant']); await invoke(['connections', 'use', connectionId]);
  assert.equal((await invoke(['agents', 'start'])).agents.length, 2);
  await invoke(['agents', 'select', firstId]);
  let firstProject;
  for (const name of ['repo-a', 'repo-b']) {
    const folder = path.join(directory, name); await mkdir(folder); await execute('git', ['-C', folder, 'init', '-q']);
    const project = await invoke(['projects', 'open', folder, connectionId]); firstProject ??= project.active;
  }
  assert.equal((await invoke(['projects', 'list'])).projects.length, 2);
  await invoke(['projects', 'select', firstProject]);
  assert.equal((await invoke(['sessions', 'list', '--area', 'assistant'])).sessions.length, 1);
  assert.equal((await invoke(['sessions', 'list', '--area', 'code'])).sessions.length, 0);
  const codeRun = await invoke(['run', '--area', 'code', 'Finish checkpoint fixture']);
  const codeSession = (await invoke(['sessions', 'inspect', codeRun.sessionId, '--area', 'code'])).session;
  const sourceFile = path.join(directory, 'repo-a', 'checkpoint.txt');
  await writeFile(sourceFile, 'saved content');
  const captured = await invoke(['checkpoints', 'capture', codeSession.sessionId, codeSession.runs[0].turnId, 'checkpoint.txt', '--area', 'code']);
  const checkpointId = captured.inspection.checkpoint.id;
  await writeFile(sourceFile, 'new content');
  const reviewed = await invoke(['checkpoints', 'prepare', checkpointId, '--area', 'code', '--session', codeSession.sessionId]);
  assert.equal(await readFile(sourceFile, 'utf8'), 'new content');
  const restored = await invoke(['checkpoints', 'apply', reviewed.operationId, reviewed.reviewedProposalId, '--area', 'code', '--session', codeSession.sessionId]);
  assert.equal(restored.session.parentSessionId, codeSession.sessionId);
  assert.equal(await readFile(sourceFile, 'utf8'), 'saved content');
  assert.equal((await invoke(['checkpoints', 'list', codeSession.sessionId, '--area', 'code'])).restores.length, 1);
  const retentionSelection = [`checkpoint:${checkpointId}`, `restore:${reviewed.operationId}`];
  const retention = await invoke(['checkpoints', 'prune-review', ...retentionSelection, '--area', 'code']);
  assert.equal((await invoke(['checkpoints', 'storage', '--area', 'code'])).records, 2);
  await invoke(['checkpoints', 'prune-apply', retention.planId, ...retentionSelection, '--area', 'code']);
  assert.equal((await invoke(['checkpoints', 'storage', '--area', 'code'])).records, 0);
  assert.equal(await readFile(sourceFile, 'utf8'), 'saved content');
  assert.equal((await invoke(['sessions', 'inspect', restored.session.sessionId, '--area', 'code'])).session.parentSessionId, codeSession.sessionId);

  assert.equal((await client.state()).state.ready, true);
  await assert.rejects(cli(['stop']), error => error.code === 2);
  assert.equal((await cli(['status'])).status, 'running');
  assert.equal((await cli(['stop', '--yes'])).status, 'stop-requested');
  for (let attempt = 0; attempt < 100 && (await cli(['status'])).status !== 'unavailable'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await cli(['status'])).status, 'unavailable');
  const report = {passed: true, directory, coreArtifactSha256: installed.sha256, checks: ['installed Node CLI', 'reviewed retention removes only selected checkpoint records and preserves files and conversations', 'Code checkpoint capture and reviewed restore through application discovery', 'automation status explicitly reports unavailable module', 'status does not start service', 'concurrent CLI auto-start', 'detached host survives both CLI exits', 'one owner lease', 'stop requires explicit yes', 'coordinator stops on explicit CLI request', 'provider JSON through stdin and native keychain', 'two agents share a connection', 'daily module configured through stdin and read from installed CLI', 'real model protocol through fixture HTTP server', 'two Git projects configured through CLI', 'Assistant and Code sessions remain isolated']};
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await cli(['stop', '--yes']).catch(() => {});
  await new AsyncEntry('ai.zhivex.assistant', createHash('sha256').update(directory).digest('hex')).deleteCredential().catch(() => {});
  server.close();
  if (pid) {try {const command = (await execute('ps', ['-p', String(pid), '-o', 'command='])).stdout; if (command.includes(directory) && command.includes(path.join(core, 'dist/service-cli.js'))) process.kill(pid, 'SIGTERM');} catch {}}
}
