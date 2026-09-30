// Usage: node scripts/smoke-global-code.mjs harness.tgz code.tgz [historical-harness.tgz]
// The selected package manager is the installer only; real global launchers run with Node and no Bun in PATH.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const manager = process.env.HARNESS_GLOBAL_MANAGER ?? 'bun';
assert(['bun', 'npm', 'pnpm', 'yarn'].includes(manager), 'Supported global installers: bun, npm, pnpm, yarn');
const managerCommand = process.env[`SMOKE_${manager.toUpperCase()}_PATH`] ?? manager;
const inputs = process.argv.slice(2);
assert(inputs.length === 2 || inputs.length === 3, 'Supply Harness, Code and optional historical Harness tarballs');
const artifacts = await Promise.all(inputs.map(async input => ({ file: path.resolve(input),
  sha256: createHash('sha256').update(await readFile(input)).digest('hex') })));
const root = await mkdtemp(path.join(os.tmpdir(), 'harness-global-code-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(API_KEY|TOKEN|BASE_URL)$/.test(key)) delete env[key];
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const nodeBin = path.join(root, 'node-only'); await mkdir(nodeBin);
await symlink(process.execPath, path.join(nodeBin, 'node'));
for (const utility of ['sh', 'sed', 'dirname', 'uname']) {
  const executable = run('/bin/sh', ['-c', `command -v ${utility}`], root).trim();
  await symlink(executable, path.join(nodeBin, utility));
}
assert.equal(spawnSync('bun', ['--version'], { env: { PATH: nodeBin } }).error?.code, 'ENOENT');
const expectedEngine = createHash('sha256').update(run('tar', ['-xOf', artifacts[0].file, 'package/dist/engine/index.js'], root)).digest('hex');
let registry;
let registryUrl;
if (process.env.HARNESS_GLOBAL_REGISTRY_FIXTURE === '1') {
  registry = fork(fileURLToPath(new URL('./candidate-registry.mjs', import.meta.url)), [artifacts[0].file],
    { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  registryUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { registry.kill(); reject(new Error('Candidate registry startup timed out')); }, 10_000);
    registry.once('message', message => { clearTimeout(timer); resolve(message.url); });
    registry.once('exit', code => { clearTimeout(timer); reject(new Error(`Candidate registry exited ${code}`)); });
    registry.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
try {
const rows = [];
for (const order of [[0, 1], [1, 0]]) {
  const row = { order, status: 'failed', steps: [] }; rows.push(row);
  try {
  const prefix = path.join(root, order.join('-')); await mkdir(prefix);
  const globalDir = path.join(prefix, manager === 'npm' ? 'lib' : 'global'); const globalBin = path.join(prefix, 'bin');
  await mkdir(globalDir); await mkdir(globalBin);
  const installerEnv = { BUN_INSTALL_GLOBAL_DIR: globalDir, BUN_INSTALL_BIN: globalBin,
    PNPM_HOME: globalBin, npm_config_global_dir: globalDir, npm_config_global_bin_dir: globalBin,
    ...(registryUrl ? { npm_config_registry: registryUrl } : {}), PATH: `${globalBin}${path.delimiter}${env.PATH}` };
  if (registryUrl) {
    for (const configDir of [prefix, globalDir]) {
      await writeFile(path.join(configDir, '.npmrc'), `registry=${registryUrl}\n@zhivex-ai:registry=${registryUrl}\n`);
      await writeFile(path.join(configDir, '.yarnrc'), `registry ${JSON.stringify(registryUrl)}\n`);
    }
  }
  const registryArgs = registryUrl ? [`--registry=${registryUrl}`, `--@zhivex-ai:registry=${registryUrl}`] : [];
  const pnpmGlobalArgs = ['--global-dir', globalDir, '--global-bin-dir', globalBin];
  const install = artifact => run(managerCommand, manager === 'npm'
    ? ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...registryArgs, artifact]
    : manager === 'pnpm' ? ['add', '--global', ...pnpmGlobalArgs, '--ignore-scripts', ...registryArgs, artifact]
    : manager === 'yarn' ? ['global', 'add', '--global-folder', globalDir, '--prefix', prefix,
      '--cache-folder', path.join(prefix, 'cache'), '--ignore-scripts', ...registryArgs, artifact]
    : ['add', '--global', '--ignore-scripts', artifact], prefix, installerEnv);
  const installed = []; const steps = row.steps;
  const manifestPath = path.join(globalDir, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ private: true }));
  if (artifacts[2]) {
    const historical = JSON.parse(run('tar', ['-xOf', artifacts[2].file, 'package/package.json'], root));
    assert.equal(historical.name, '@zhivex-ai/harness');
    install(artifacts[2].file);
    for (const binary of ['zhx', 'zhivex-harness']) {
      const launcher = path.join(globalBin, binary);
      assert(run(launcher, ['--help'], prefix, { PATH: nodeBin }).length > 0);
      assert(run(launcher, ['--version'], prefix, { PATH: nodeBin }).includes(historical.version));
    }
    steps.push({ artifact: 2, version: historical.version, launchers: ['zhx', 'zhivex-harness'] });
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.overrides = { '@zhivex-ai/harness': `file:${artifacts[0].file}` };
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (const index of order) {
    install(artifacts[index].file);
    installed.push(index);
    for (const installedIndex of installed) {
      const packageName = installedIndex === 0 ? 'harness' : 'code';
      let packageDir = path.join(globalDir, 'node_modules/@zhivex-ai', packageName);
      if (manager === 'pnpm') {
        // pnpm 11 isolates global packages into separate installation roots.
        const matches = new Set();
        for (const version of await readdir(globalDir, { withFileTypes: true })) {
          if (!version.isDirectory() || !/^v\d+$/.test(version.name)) continue;
          const versionDir = path.join(globalDir, version.name);
          for (const entry of await readdir(versionDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const installation = path.join(versionDir, entry.name);
            const declaration = JSON.parse(await readFile(path.join(installation, 'package.json'), 'utf8'));
            if (declaration.dependencies?.[`@zhivex-ai/${packageName}`]) {
              matches.add(await realpath(path.join(installation, 'node_modules/@zhivex-ai', packageName)));
            }
          }
        }
        assert.equal(matches.size, 1, 'Expected one isolated pnpm global package installation');
        packageDir = [...matches][0];
      }
      const digest = run(process.execPath, ['--input-type=module', '-e',
        "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync(new URL(import.meta.resolve('@zhivex-ai/harness/engine')))).digest('hex'))"], packageDir, { PATH: nodeBin }).trim();
      assert.equal(digest, expectedEngine, 'Global consumer resolved registry or different Harness bytes');
    }
    const binaries = [...((installed.includes(0) || artifacts[2]) ? ['zhx', 'zhivex-harness', 'zhx-acp'] : []),
      ...(installed.includes(1) ? ['zhivex-code'] : [])];
    for (const binary of binaries) {
      const launcher = path.join(globalBin, binary);
      const target = await realpath(launcher);
      assert(target.startsWith(await realpath(prefix) + path.sep), 'Global launcher escaped test prefix');
      const output = run(launcher, ['--help'], prefix, { PATH: nodeBin });
      if (binary !== 'zhx-acp') assert(output.length > 0);
    }
    steps.push({ artifact: index, launchers: binaries });
  }
  const fixture = path.join(prefix, 'provider.mjs');
  await copyFile(fileURLToPath(new URL('./installed-provider-fixture.mjs', import.meta.url)), fixture);
  for (const binary of ['zhx', 'zhivex-harness', 'zhivex-code']) {
    const result = run(path.join(globalBin, binary), ['run', 'Reply with installed-cli-ok',
      '--provider', 'openai', '--model', 'gpt-5.6', '--json'], prefix,
    { PATH: nodeBin, NODE_OPTIONS: `--import=${fixture}`, OPENAI_API_KEY: 'installed-fixture-only' });
    assert.equal(JSON.parse(result).status, 'completed');
    assert.equal(JSON.parse(result).output, 'installed-cli-ok');
  }
  row.status = 'passed';
  } catch (error) { row.error = String(error); console.error(`${manager} global ${order.join('-')} failed: ${error}`); }
}
const report = { artifacts, registryMode: registryUrl ? 'loopback-exact-candidate' : 'default-registry', manager: { name: manager, version: run(managerCommand, ['--version'], root).trim() }, node: process.version, rows, root };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (rows.some(row => row.status !== 'passed')) process.exitCode = 1;

} finally { if (registry?.connected) registry.disconnect(); }
