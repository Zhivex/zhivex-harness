import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPortableProcess } from '../src/execution/process-runtime.js';
const checkout = path.resolve(import.meta.dir, '..');
const root = await mkdtemp(path.join(tmpdir(), 'zhx-installed-mcp-'));
const artifact = path.join(root, 'harness.tgz');
async function run(argv: string[], cwd = root) {
  const result = await runPortableProcess(argv, { cwd, env: process.env, timeoutMs: 180000, maxOutputCharacters: 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Installed MCP verification failed: ${argv[0]}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
if (process.env.HARNESS_MCP_ARTIFACT) {
  await copyFile(path.resolve(process.env.HARNESS_MCP_ARTIFACT), artifact);
} else {
  await run(['bun', 'pm', 'pack', '--ignore-scripts', '--quiet', '--filename', artifact], checkout);
}
const manifest = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8'));
await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'installed-mcp-proof', private: true, type: 'module', dependencies: {
  '@zhivex-ai/harness': `file:${artifact}`, '@zhivex-ai/agents': manifest.dependencies['@zhivex-ai/agents']
} }));
await run(['bun', 'install', '--ignore-scripts']);
const source = await readFile(path.join(checkout, 'scripts/mcp-stdio-agent-smoke.ts'), 'utf8');
const imports = `import { createHarness, runHarness, Workspace, resolveHarnessConfig, openHarnessPersistence, normalizeHarnessMcpConfiguration } from '@zhivex-ai/harness';
import { prepareMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot, launchIsolatedMcpSession as launchDockerMcpTools, createMcpStdioAdmissionAuthority } from '@zhivex-ai/harness/mcp/stdio/v1';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function runPortableProcess(argv, options) {
  try { const result = await exec(argv[0], argv.slice(1), { env: options.env, timeout: options.timeoutMs, maxBuffer: options.maxOutputCharacters });
    return { exitCode: 0, timedOut: false, stdout: result.stdout, stderr: result.stderr }; }
  catch { throw new Error('Installed consumer Docker command failed'); }
}
assert.ok(import.meta.resolve('@zhivex-ai/harness').includes('/node_modules/@zhivex-ai/harness/'));
assert.throws(() => normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{ name: 'unsafe', transport: 'stdio', command: '/bin/sh' }] }));
await assert.rejects(createHarness({ isolatedMcpSession: {} }), /host-admitted/);
`;
const consumer = imports + source.split('\n').filter(line => !line.includes("from '../src/")).join('\n')
  .replace('Real OCI MCP with fixture language model and actual harness approval/resume; installed acceptance remains pending', 'Installed tarball public APIs, real Docker, actual harness approval and SQLite resume');
await writeFile(path.join(root, 'consumer.mjs'), new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(consumer));
const runtimes = process.argv.slice(2).length ? process.argv.slice(2) : ['node', 'bun'];
const evidence = [];
for (const runtime of runtimes) {
  const version = (await run([runtime, '--version'])).trim();
  const result = await run([runtime, path.join(root, 'consumer.mjs')]);
  evidence.push({ runtime, version, result: JSON.parse(result) });
}
const report = { artifact, version: manifest.version, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), evidence };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
