import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

assert.equal(childProcess.spawnSync('bun', ['--version']).error?.code, 'ENOENT');
const original = { stdout: process.stdout.write, stderr: process.stderr.write, stdinOn: process.stdin.on,
  stdinResume: process.stdin.resume };
const forbidden = name => () => { throw new Error(`Import produced forbidden effect: ${name}`); };
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = forbidden(`child_process.${method}`);
}
syncBuiltinESMExports();
process.stdout.write = forbidden('stdout.write');
process.stderr.write = forbidden('stderr.write');
process.stdin.on = forbidden('stdin.on');
process.stdin.resume = forbidden('stdin.resume');
try {
  for (const entry of ['engine', 'client', 'protocol', 'service', 'acp', 'code-support']) await import(`@zhivex-ai/harness/${entry}`);
  await import('@zhivex-ai/harness');
} finally {
  process.stdout.write = original.stdout; process.stderr.write = original.stderr;
  process.stdin.on = original.stdinOn; process.stdin.resume = original.stdinResume;
}
console.log('INSTALLED_IMPORTS_WITHOUT_TERMINAL_OR_CHILD_PROCESS_EFFECTS_OK');

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@zhivex-ai/harness'))), '..');
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const contract = JSON.parse(await readFile(path.join(packageRoot, 'contracts/engine-api.json'), 'utf8'));
for (const [subpath, entry] of Object.entries(contract.entrypoints)) {
  const api = await import(`@zhivex-ai/harness${subpath.slice(1)}`);
  assert.deepEqual(Object.keys(api).sort(), entry.exports.filter(e => e.kind === 'runtime').map(e => e.name).sort(), subpath);
  for (const kind of ['types', 'import']) assert((await stat(path.join(packageRoot, manifest.exports[subpath][kind]))).isFile());
}
const root = await import('@zhivex-ai/harness');
const engine = await import('@zhivex-ai/harness/engine');
assert.equal(engine.HarnessError, root.HarnessError);
const visited = new Set();
async function verifyBrowserClosure(file) {
  if (visited.has(file)) return; visited.add(file);
  const source = await readFile(file, 'utf8');
  assert(!/(?:from\s*|import\s*|require\s*\()?["']node:/.test(source), `Browser protocol contains Node dependency: ${file}`);
  for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) await verifyBrowserClosure(path.resolve(path.dirname(file), match[1]));
}
await verifyBrowserClosure(path.join(packageRoot, manifest.exports['./protocol'].import));
console.log('INSTALLED_EXPORT_CONTRACT_AND_BROWSER_CLOSURE_OK');
