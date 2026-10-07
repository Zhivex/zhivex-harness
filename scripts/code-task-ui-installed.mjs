// Integrated HU75/CODE05 fixture: exact installed product, no live provider or pilot.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access, readdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
const repo = fileURLToPath(new URL('../', import.meta.url));
const [engineArg, codeArg, runtimeArg, outputArg] = process.argv.slice(2);
assert(engineArg && codeArg && runtimeArg && outputArg, 'Pass exact Harness tarball, Code tarball, Node executable and output directory');
const engine = path.resolve(engineArg), code = path.resolve(codeArg), output = path.resolve(outputArg), runtime = path.resolve(runtimeArg);
const root = await mkdtemp('/tmp/code05-installed-');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const env = Object.fromEntries(['LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'WEB_BROWSER_PATH', 'PLAYWRIGHT_BROWSERS_PATH'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
// Resolve browser tooling before giving the isolated consumer its private HOME.
if (!env.WEB_BROWSER_PATH) env.WEB_BROWSER_PATH = createRequire(repo + 'packages/web/package.json')('playwright').chromium.executablePath();
let stage = 'source', cleanup = true, report, sequence = 0;
await mkdir(output, { recursive: true });
async function run(command, args, cwd = root, timeout = 180000) {
  const child = spawn(command, args, { cwd, detached: true, env: { ...env, PATH: path.dirname(runtime) + ':' + process.env.PATH,
    HOME: root, CI: '1', NO_COLOR: '1', NODE_NO_WARNINGS: '1', npm_config_cache: root + '/cache', HARNESS_RECOVERY_LAB_ROOT: root + '/fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let bytes = 0, timedOut = false;
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanup = false; } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) kill(); else target.push(data); });
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString();
    if (err || status !== 0) await writeFile(output + '/process-' + (++sequence) + '.log', (out + '\n' + err).replaceAll(root, '[CONSUMER_ROOT]'));
    if (status !== 0 || timedOut || bytes > 4 * 1024 * 1024) { cleanup = false; throw Error(timedOut ? 'PROCESS_TIMEOUT' : 'PROCESS_FAILED'); }
    return out;
  } finally { clearTimeout(timer); kill(); }
}
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(directory + '/' + entry.name, name + '/'));
    else { assert(entry.isFile(), 'Only regular packaged files are supported'); result.push(name); }
  }
  return result.sort();
}
const binding = {};
try {
  binding.sourceSha = (await run('git', ['rev-parse', 'HEAD'], repo)).trim();
  assert.equal((await run('git', ['status', '--porcelain'], repo)).trim(), '', 'Clean source required');
  binding.artifacts = {};
  for (const [name, filename] of [['harness', engine], ['code', code]]) {
    const bytes = await readFile(filename); binding.artifacts[name] = { sha256: digest(bytes), bytes: bytes.length };
    await writeFile(root + '/' + name + '.tgz', bytes);
  }
  const browserScript = repo + 'packages/web/scripts/task-browser-journey.mjs';
  const tracked = [browserScript, repo + 'packages/web/scripts/task-offline-provider.mjs', repo + 'scripts/task-recovery-lab-consumer.mjs', repo + 'scripts/task-projection-consumer.mjs',
    repo + 'evaluations/task-recovery-lab.json', repo + 'evaluations/task-projection.json', repo + 'evaluations/code-task-ui.json', fileURLToPath(import.meta.url)];
  const frozen = await Promise.all(tracked.map(file => readFile(file)));
  const scriptHashes = frozen.map(digest);
  binding.inputHashes = Object.fromEntries(tracked.map((file, index) => [path.relative(repo, file), scriptHashes[index]]));
  const executedCopies = [];
  const uiManifest = JSON.parse(frozen[6]);
  await writeFile(root + '/package.json', JSON.stringify({ private: true, type: 'module', dependencies: {
    '@zhivex-ai/harness': 'file:' + root + '/harness.tgz', '@zhivex-ai/code': 'file:' + root + '/code.tgz' },
    overrides: { '@zhivex-ai/harness': 'file:' + root + '/harness.tgz' } }));
  stage = 'install'; await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  const codeRoot = root + '/node_modules/@zhivex-ai/code';
  stage = 'binding';
  const productHashes = [];
  // Verify every installed product byte against the selected tarballs, including UI assets.
  for (const name of ['harness', 'code']) {
    const extracted = root + '/packed-' + name; await mkdir(extracted);
    await run('tar', ['-xf', root + '/' + name + '.tgz', '-C', extracted]);
    for (const filename of await files(extracted + '/package')) {
      const installedPath = root + '/node_modules/@zhivex-ai/' + name + '/' + filename, sha256 = digest(await readFile(extracted + '/package/' + filename));
      assert.equal(digest(await readFile(installedPath)), sha256, 'Installed file mismatch: ' + name + '/' + filename);
      productHashes.push({ path: installedPath, sha256 });
    }
  }
  await writeFile(codeRoot + '/task-binding.mjs', "export const engine=import.meta.resolve('@zhivex-ai/harness/engine');\n");
  await writeFile(root + '/binding.mjs', "import {engine} from './node_modules/@zhivex-ai/code/task-binding.mjs'; console.log(JSON.stringify({code:engine,root:import.meta.resolve('@zhivex-ai/harness/engine')}));\n");
  const resolved = JSON.parse(await run(runtime, [root + '/binding.mjs']));
  assert.equal(await realpath(fileURLToPath(resolved.code)), await realpath(fileURLToPath(resolved.root)));
  assert((await realpath(fileURLToPath(resolved.root))).startsWith(await realpath(root) + path.sep));
  binding.versions = {};
  for (const name of ['harness', 'code', 'agents', 'core']) binding.versions[name] = JSON.parse(await readFile(root + '/node_modules/@zhivex-ai/' + name + '/package.json')).version;
  assert.equal(JSON.parse(await readFile(codeRoot + '/package.json')).dependencies['@zhivex-ai/harness'], binding.versions.harness);
  binding.sameInstalledEngineForCodeAndService = true;
  const fixtureSha256 = uiManifest.fixtureSha256;
  const results = {};
  for (const profile of ['recovery', 'projection']) {
    stage = profile;
    const index = profile === 'recovery' ? 2 : 3, copy = root + '/' + profile + '-consumer.mjs';
    await writeFile(copy, frozen[index]); executedCopies.push({ path: copy, sha256: scriptHashes[index] });
    const manifestCopy = root + '/' + profile + '-manifest.json';
    await writeFile(manifestCopy, frozen[index + 2]); executedCopies.push({ path: manifestCopy, sha256: scriptHashes[index + 2] });
    const result = JSON.parse(await run(runtime, [copy], root, 90000));
    const manifest = JSON.parse(frozen[index + 2]);
    assert.equal(result.status, 'passed'); assert.equal(result.fixtureSha256, fixtureSha256);
    assert.deepEqual(result.scenarios.map(s => s.id).sort(), [...manifest.installedScenarios].sort());
    results[profile] = result; await writeFile(output + '/' + profile + '.json', JSON.stringify(result, null, 2) + '\n');
  }
  stage = 'browser';
  await mkdir(root + '/driver');
  // Only browser-driver tooling is shared; all product imports resolve in the isolated consumer.
  await symlink(repo + 'packages/web/node_modules', root + '/driver/node_modules', 'dir');
  for (const index of [0, 1]) {
    const copy = root + '/driver/' + path.basename(tracked[index]);
    await writeFile(copy, frozen[index]); executedCopies.push({ path: copy, sha256: scriptHashes[index] });
  }
  await run(runtime, [root + '/driver/task-browser-journey.mjs', codeRoot, output + '/browser'], root);
  results.browser = JSON.parse(await readFile(output + '/browser/report.json'));
  assert.equal(results.browser.status, 'passed'); assert.equal(results.browser.fixtureSha256, fixtureSha256);
  assert.deepEqual(results.browser.scenarios.map(s => s.id).sort(), [...uiManifest.browserScenarios].sort()); assert(results.browser.scenarios.every(s => s.status === 'passed'));
  stage = 'verify';
  // Explicit negative control for this artifact validator only. It must produce a failed report.
  if (process.env.CODE_TASK_UI_NEGATIVE_MUTATION === '1') await writeFile(codeRoot + '/dist/cli.js', '// negative-control mutation\n');
  for (const name of ['harness', 'code']) {
    assert.equal(digest(await readFile(root + '/' + name + '.tgz')), binding.artifacts[name].sha256);
  }
  for (const file of productHashes) assert.equal(digest(await readFile(file.path)), file.sha256, 'Installed product changed');
  for (const copy of executedCopies) assert.equal(digest(await readFile(copy.path)), copy.sha256);
  for (const [name, filename] of [['harness', engine], ['code', code]]) assert.equal(digest(await readFile(filename)), binding.artifacts[name].sha256);
  assert.deepEqual(await Promise.all(tracked.map(async file => digest(await readFile(file)))), scriptHashes);
  assert.equal((await run('git', ['rev-parse', 'HEAD'], repo)).trim(), binding.sourceSha);
  assert.equal((await run('git', ['status', '--porcelain'], repo)).trim(), '');
  report = { ...binding, status: 'passed', artifactBindingVerified: true, sourceDirty: false, fixtureSha256,
    automatedIntegratedJourneyPassed: true, humanPilotPerformed: false, liveProvider: false, humanMinutes: null, realCostPerAcceptedTask: null,
    scenarios: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.scenarios])), node: await run(runtime, ['--version']) };
} catch (error) {
  report = { ...binding, status: 'failed', stage, diagnostic: error instanceof assert.AssertionError ? 'BINDING_OR_ACCEPTANCE_FAILED' : error.message, automatedIntegratedJourneyPassed: false };
  process.exitCode = 1;
} finally {
  try { await rm(root, { recursive: true, force: true }); await assert.rejects(access(root), { code: 'ENOENT' }); } catch { cleanup = false; }
  report.cleanup = cleanup ? 'completed' : 'unconfirmed'; if (!cleanup) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
