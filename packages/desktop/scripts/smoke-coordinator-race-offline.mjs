// Real Node and Electron utility processes, installed core, injected memory-only secrets.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, access} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = await mkdtemp('/tmp/zhx-race-offline-');
const installed = JSON.parse(await readFile(root + '/packages/desktop/.harness/installed.json', 'utf8'));
const core = path.join(installed.install, 'node_modules/@zhivex-ai/harness/dist/engine/application.js');
const clientModule = path.join(installed.install, 'node_modules/@zhivex-ai/harness/dist/engine/application-client.js');
const {connectCoordinator} = await import(pathToFileURL(clientModule).href);
const wait = async check => {const deadline = Date.now() + 20000; while (!await check()) {if (Date.now() > deadline) throw new Error('FIXTURE_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 30));}};
const exists = file => access(file).then(() => true, () => false);
await writeFile(output + '/worker.cjs', `
(async () => {
 const {writeFile, access} = require('node:fs/promises');
 const {acquireApplicationCoordinator} = await import(${JSON.stringify(pathToFileURL(core).href)});
 const root = ${JSON.stringify(output)}, role = process.argv[2];
 const exists = file => access(file).then(() => true, () => false);
 await writeFile(root + '/' + role + '.ready', 'ready');
 while (!await exists(root + '/go')) await new Promise(r => setTimeout(r, 10));
 let reads = 0, stored = null;
 const owner = await acquireApplicationCoordinator(root + '/app', {secrets: {async read() {reads++; return stored;}, async write(value) {stored = value;}}});
 await writeFile(root + '/' + role + '.json', JSON.stringify({pid: process.pid, owned: owner.ownsService, reads, protocol: owner.client.protocol}));
 while (!await exists(root + '/stop')) await new Promise(r => setTimeout(r, 30));
 await owner.close(); process.exit(0);
})().catch(error => {console.error(error); process.exit(1);});
`);
await writeFile(output + '/electron.cjs', `
const {app, utilityProcess} = require('electron');
app.whenReady().then(() => {
 const child = utilityProcess.fork(${JSON.stringify(output + '/worker.cjs')}, ['electron'], {stdio: 'pipe'});
 child.stderr.on('data', chunk => process.stderr.write(chunk));
 child.on('exit', code => app.exit(code));
});
`);
const children = [], errors = [];
const launch = (executable, args) => {const child = spawn(executable, args, {stdio: ['ignore', 'ignore', 'pipe']}); child.stderr.on('data', chunk => errors.push(chunk.toString())); children.push(child); return child;};
try {
  launch('node', [output + '/worker.cjs', 'node']);
  launch(root + '/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', [output + '/electron.cjs', '--user-data-dir=' + output + '/electron-data']);
  await wait(async () => await exists(output + '/node.ready') && await exists(output + '/electron.ready'));
  await writeFile(output + '/go', 'go');
  await wait(async () => await exists(output + '/node.json') && await exists(output + '/electron.json'));
  const results = await Promise.all(['node', 'electron'].map(async role => ({role, ...JSON.parse(await readFile(output + '/' + role + '.json', 'utf8'))})));
  assert.equal(results.filter(result => result.owned).length, 1);
  assert.equal(results.reduce((total, result) => total + result.reads, 0), 1);
  assert.equal(results[0].protocol.generation, results[1].protocol.generation);
  const client = await connectCoordinator(output + '/app');
  await assert.rejects(connectCoordinator(output + '/app', {versions: [99]}), error => error.code === 'COORDINATOR_VERSION_UNSUPPORTED' && error.detail.recovery === 'upgrade');
  await client.call('action', {name: 'begin', value: {name: 'Shared draft'}});
  assert.equal((await (await connectCoordinator(output + '/app')).state()).state.draftName, 'Shared draft');
  await client.call('shutdown', {confirmed: true});
  await wait(async () => !await exists(output + '/app/coordinator.json'));
  await assert.rejects(client.state());
  await writeFile(output + '/stop', 'stop');
  await wait(async () => children.every(child => child.exitCode !== null));
  assert(children.every(child => child.exitCode === 0), errors.join(''));
  const report = {passed: true, coreArtifactSha256: installed.sha256, results, checks: ['barrier-started Node and Electron utility processes share one owner and generation', 'only owner reads injected secret store', 'both SQLite runtimes admit safely', 'incompatible client receives upgrade recovery', 'confirmed shutdown disconnects all clients'], limitations: ['Memory-only synthetic credentials; no keychain or signing certification']};
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, ...report}, null, 2));
} finally {
  await writeFile(output + '/stop', 'stop');
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await writeFile(output + '/runtime.log', errors.join(''));
}
