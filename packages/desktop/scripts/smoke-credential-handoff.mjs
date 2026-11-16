import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await realpath(process.argv[2] ?? '');
if (!directory.startsWith('/private/tmp/zhx-')) throw new Error('Use an existing disposable zhx test profile, not a personal profile.');
const installed = JSON.parse(await readFile(path.join(root, 'packages/desktop/.harness/installed.json'), 'utf8'));
const core = path.join(installed.install, 'node_modules/@zhivex-ai/harness');
const {createProcessSecretStore} = await import(path.join(core, 'dist/engine/application.js'));
const store = await createProcessSecretStore(directory, {executable: 'node', entry: path.join(core, 'dist/service-cli.js'), args: ['--credential-worker']});
const started = Date.now(); let outcome;
try {const value = await store.read(); outcome = value === null ? 'absent' : 'readable';}
catch (error) {assert.equal(error.message, 'SETUP_KEYCHAIN_UNAVAILABLE'); outcome = 'unavailable';}
const elapsedMs = Date.now() - started; assert(elapsedMs < 12000);
const {stdout} = await promisify(execFile)('ps', ['-ax', '-o', 'pid=,ppid=,command=']);
const children = stdout.split('\n').filter(line => {const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return match && Number(match[2]) === process.pid && match[3].includes('--credential-worker');});
assert.equal(children.length, 0);
const report = {passed: true, directory, coreArtifactSha256: installed.sha256, outcome, elapsedMs, checks: ['native read completed or failed within deadline', 'credential child exited and was reaped before result', 'no credential value logged', 'no keychain write or permission change'], limitations: 'A bounded unavailable result certifies isolation and cleanup, not native authorization or successful cross-identity access.'};
await writeFile(path.join(directory, 'credential-isolation-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
