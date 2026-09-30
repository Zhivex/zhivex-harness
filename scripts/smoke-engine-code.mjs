#!/usr/bin/env node
// Usage: node scripts/smoke-engine-code.mjs harness.tgz code.tgz [npm,pnpm,yarn,bun]
// Artifacts must already be built. Installs disable scripts: no consumer TypeScript/compiler required.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [harnessInput, codeInput, selected = 'npm,pnpm,yarn,bun'] = process.argv.slice(2);
assert(harnessInput && codeInput, 'Provide built Harness and Code tarballs');
const tarballs = [harnessInput, codeInput].map(p => path.resolve(p));
const root = await mkdtemp(path.join(os.tmpdir(), 'harness-code-consumers-'));
const report = { runtime: { node: process.version, platform: process.platform, arch: process.arch }, artifacts: await Promise.all(tarballs.map(async file => ({ file,
  sha256: createHash('sha256').update(await readFile(file)).digest('hex') }))), consumers: [] };
const run = (command, args, cwd, env, allowFailure = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.stdout.on('data', b => { stdout += b; if (args.includes('add') || args.includes('install')) appendFileSync(path.join(cwd, 'install.log'), b); }); child.stderr.on('data', b => { stderr += b; if (args.includes('add') || args.includes('install')) appendFileSync(path.join(cwd, 'install.log'), b); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); const result = { code, stdout, stderr };
    if (code !== 0 && !allowFailure) reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`));
    else resolve(result);
  });
});
const env = { ...process.env, NPM_CONFIG_CACHE: path.join(root, 'npm-cache') };
for (const key of Object.keys(env)) if (/(API_KEY|TOKEN|BASE_URL)$/.test(key)) delete env[key];
// Expose only the required executables. Bun cannot resolve even when installed globally.
const bin = path.join(root, 'node-only-bin'); await mkdir(bin);
await symlink(process.execPath, path.join(bin, 'node'));
for (const executable of ['git', 'sh', 'sed', 'dirname', 'uname']) {
  const found = await run('/bin/sh', ['-c', `command -v ${executable}`], root, env);
  await symlink(found.stdout.trim(), path.join(bin, executable));
}
const nodeEnv = { ...env, PATH: bin };
const providerEnv = { ...nodeEnv, OPENAI_API_KEY: 'installed-fixture-only' };
  for (const manager of selected.split(',')) for (const order of ['harness-first', 'code-first']) {
    const row = { manager, order, status: 'failed', transitiveArtifactOverride: manager === 'pnpm' ? { config: 'pnpm-workspace.yaml', selector: '@zhivex-ai/harness', resolution: `file:${tarballs[0]}` } : manager === 'yarn' ? { config: 'package.json resolutions', selector: '@zhivex-ai/harness', resolution: `file:${tarballs[0]}` } : { config: 'package.json overrides and direct file dependencies', resolution: `file:${tarballs[0]}` } }; report.consumers.push(row);
    console.error(`Checking ${manager} installed consumer...`);
    try {
      assert(['npm', 'pnpm', 'yarn', 'bun'].includes(manager), `Unknown manager ${manager}`);
      const command = process.env[`SMOKE_${manager.toUpperCase()}_PATH`] || manager;
      row.version = (await run(command, ['--version'], root, env)).stdout.trim();
      const consumer = path.join(root, `${manager}-${order}`); await mkdir(consumer);
      // Use one spelling for file references: Yarn otherwise caches absolute and
      // relative references as competing patterns and may remove existing launchers.
      const artifactSpecs = tarballs.map(file => `file:${path.relative(consumer, file)}`);
      const consumerManifest = { name: 'installed-proof', private: true, type: 'module',
        dependencies: {},
        overrides: { '@zhivex-ai/harness': artifactSpecs[0] },
        pnpm: { overrides: { '@zhivex-ai/harness': artifactSpecs[0] } },
        resolutions: { '@zhivex-ai/harness': artifactSpecs[0] } };
      if (manager === 'pnpm') await writeFile(path.join(consumer, 'pnpm-workspace.yaml'), `overrides:\n  '@zhivex-ai/harness': ${JSON.stringify(artifactSpecs[0])}\n`);
      // Yarn classic uses node_modules; modern Yarn must explicitly select it.
      await writeFile(path.join(consumer, '.yarnrc.yml'), `nodeLinker: node-modules\nenableScripts: false\nnpmRegistryServer: https://registry.npmjs.org\ncacheFolder: ${JSON.stringify(path.join(root, 'yarn-cache'))}\n`);
      row.installSteps = [];
      const installOrder = order === 'harness-first' ? [0, 1] : [1, 0];
      for (const index of installOrder) {
        const name = index === 0 ? '@zhivex-ai/harness' : '@zhivex-ai/code';
        consumerManifest.dependencies[name] = artifactSpecs[index];
        await writeFile(path.join(consumer, 'package.json'), JSON.stringify(consumerManifest));
        const args = manager === 'npm' ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
          : manager === 'pnpm' || manager === 'bun' ? ['install', '--ignore-scripts']
          : Number(row.version.split('.')[0]) >= 2 ? ['install'] : ['install', '--ignore-scripts', '--registry', 'https://registry.npmjs.org', '--cache-folder', path.join(root, 'yarn-cache')];
        await run(command, args, consumer, env);
        // Exercise the actual manager-created launchers, not only package entry files.
        const binaries = [
          ...(consumerManifest.dependencies['@zhivex-ai/harness'] ? ['zhx', 'zhivex-harness', 'zhx-acp'] : []),
          ...(consumerManifest.dependencies['@zhivex-ai/code'] ? ['zhivex-code'] : []),
        ];
        for (const binary of binaries) {
          const help = await run(path.join(consumer, 'node_modules/.bin', binary), ['--help'], consumer, nodeEnv);
          // ACP is a stdio protocol process: with EOF it exits cleanly without CLI help.
          if (binary !== 'zhx-acp') assert(help.stdout.length > 0, `${binary} launcher failed after installing ${name}`);
        }
        row.installSteps.push({ installed: name, launchers: binaries });
      }
      const harness = JSON.parse(await readFile(path.join(consumer, 'node_modules/@zhivex-ai/harness/package.json'), 'utf8'));
      const code = JSON.parse(await readFile(path.join(consumer, 'node_modules/@zhivex-ai/code/package.json'), 'utf8'));
      for (const manifest of [harness, code]) for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
          assert(!/^(?:workspace:|link:|file:)/.test(specifier), `${manifest.name} contains unpublished dependency ${name}: ${specifier}`);
        }
      }
      assert(!harness.dependencies?.['@zhivex-ai/code'], 'Harness must not depend on Code');
      assert.deepEqual(Object.keys(code.bin), ['zhivex-code'], 'Code must not claim legacy Harness binaries');
      assert(!Object.keys(code.bin).some(name => name in harness.bin), 'Package binaries collide');
      row.localTransitiveOverride = '@zhivex-ai/harness resolved to supplied tarball (unpublished prerelease)';
      row.installedVersions = { harness: harness.version, code: code.version };
      const seen = new Set(); let harnessCopies = 0;
      const expectedEngine = await readFile(path.join(consumer, 'node_modules/@zhivex-ai/harness/dist/engine/index.js'));
      async function verifyHarnessCopies(directory) {
        const resolved = await realpath(directory); if (seen.has(resolved)) return; seen.add(resolved);
        if (path.basename(directory) === 'harness' && path.basename(path.dirname(directory)) === '@zhivex-ai') {
          const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
          assert.equal(candidate.version, harness.version, 'Mixed registry/candidate Harness versions');
          assert.deepEqual(await readFile(path.join(directory, 'dist/engine/index.js')), expectedEngine, 'Mixed Harness artifacts');
          harnessCopies++;
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) await verifyHarnessCopies(path.join(directory, entry.name));
          else if (entry.isSymbolicLink()) {
            try { await verifyHarnessCopies(path.join(directory, entry.name)); }
            catch (error) { if (!['ENOTDIR', 'ENOENT'].includes(error.code)) throw error; }
          }
        }
      }
      await verifyHarnessCopies(path.join(consumer, 'node_modules')); row.verifiedHarnessCopies = harnessCopies;
      assert(!harness.scripts?.postinstall && !code.scripts?.postinstall, 'Install-time build is forbidden');
      const imports = path.join(consumer, 'imports.mjs');
      await copyFile(fileURLToPath(new URL('./installed-import-consumer.mjs', import.meta.url)), imports);
      await run(process.execPath, [imports], consumer, nodeEnv);
      const fixture = path.join(consumer, 'engine.mjs');
      await copyFile(fileURLToPath(new URL('./installed-engine-consumer.mjs', import.meta.url)), fixture);
      for (const phase of ['create', 'resume', 'cancel']) await run(process.execPath, [fixture, phase], consumer, nodeEnv);
      const providerFixture = path.join(consumer, 'provider.mjs');
      await copyFile(fileURLToPath(new URL('./installed-provider-fixture.mjs', import.meta.url)), providerFixture);
      for (const binary of ['zhivex-harness', 'zhx', 'zhivex-code']) {
        const packageName = binary === 'zhivex-code' ? 'code' : 'harness';
        const packageManifest = packageName === 'code' ? code : harness;
        const entry = path.join(consumer, 'node_modules/@zhivex-ai', packageName, packageManifest.bin[binary]);
        const help = await run(process.execPath, [entry, '--help'], consumer, nodeEnv);
        assert(help.stdout.length > 0, `${binary} has no help`);
        const result = await run(process.execPath, ['--import', providerFixture, entry, 'run', 'Reply with installed-cli-ok', '--provider', 'openai', '--model', 'gpt-5.6', '--json'], consumer, providerEnv);
        assert.equal(JSON.parse(result.stdout).status, 'completed', `${binary} execution failed`);
        assert.equal(JSON.parse(result.stdout).output, 'installed-cli-ok', `${binary} lost provider output`);
        const cancelDirectory = path.join(consumer, `cancel-${binary}`); await mkdir(cancelDirectory);
        await run(process.execPath, [fixture, 'create'], cancelDirectory, nodeEnv);
        const runId = JSON.parse(await readFile(path.join(cancelDirectory, 'run-id.json'), 'utf8'));
        const cancelled = await run(process.execPath, [entry, 'runs', 'cancel', runId, '--state-dir', path.join(cancelDirectory, '.state'), '--final', '--json'], cancelDirectory, nodeEnv);
        assert.equal(JSON.parse(cancelled.stdout).run.status, 'cancelled', `${binary} cancellation failed`);
        await assert.rejects(readFile(path.join(cancelDirectory, 'approved.txt')));
        const inspection = await run(process.execPath, [entry, 'runs', 'inspect', runId, '--state-dir', path.join(cancelDirectory, '.state'), '--json'], cancelDirectory, nodeEnv);
        assert.equal(JSON.parse(inspection.stdout).run.status, 'cancelled', `${binary} cancellation was not durable`);
      }
      console.error(`${manager} installed consumer passed`);
      row.status = 'passed'; row.checks = ['ordered-local-install', 'manager-bin-launchers', 'disjoint-bin-ownership', 'imports', 'no-bun-in-path', 'approval-before-write', 'cross-process-durable-resume', 'cancel-persisted', 'cli-help', 'cli-execution', 'cli-durable-cancellation'];
    } catch (error) { row.error = String(error); console.error(`${manager} failed: ${row.error}`); }
  }
console.log(JSON.stringify(report, null, 2));
if (report.consumers.some(row => row.status !== 'passed')) { console.error(`Failed consumer evidence retained at ${root}`); process.exitCode = 1; }
else await rm(root, { recursive: true, force: true });
