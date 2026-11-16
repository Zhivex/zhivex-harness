import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), directory = path.resolve(process.argv[2]!);
await mkdir(directory, { recursive: true });
const git = (args: string[]) => { const p = Bun.spawnSync(['git', ...args]); assert.equal(p.exitCode, 0); return p.stdout.toString(); };
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const paths = ['context/request-projection.ts', 'context/adaptive-compaction.ts', 'context/scoped-context.ts', 'runtime/context-runtime.ts'];
const overrides = new Map<string, string>();
for (const file of paths) overrides.set(path.join(root, 'packages/core/src', file), git(['show', `HEAD:src/${file}`]));
const harnessPath = path.join(root, 'packages/core/src/runtime/harness.ts');
let harness = await readFile(harnessPath, 'utf8');
assert(harness.includes('const projectionScope ='));
harness = harness.replace('selectRequestTools, canProjectToolResults, REQUEST_PROJECTION_VERSION', 'selectRequestTools, REQUEST_PROJECTION_VERSION');
const start = harness.indexOf('  // Match the SDK/tool context scope;');
const end = harness.indexOf('  if (input.compaction === undefined)', start);
assert(start > 0 && end > start);
harness = harness.slice(0, start) + `  const projection = createRequestProjection(async () => harness.store.load(runId, deliveryScope), preservedTools);
  harness = { ...harness, agent: new Agent({
    ...Object.fromEntries(Object.entries(harness.agent).filter(([, value]) => value !== undefined)),
    model: wrapLanguageModel(harness.agent.model, [projection])
  }) };
` + harness.slice(end);
harness = harness.replace(/      projectMessages: messages => \{[\s\S]*?\n      \},\n      selectTools:/, '      selectTools:');
assert(!harness.includes('projectionStore') && !harness.includes('canProjectToolResults'));
overrides.set(harnessPath, harness);
const policyPath = path.join(root, 'packages/core/src/runtime/tool-policy.ts');
const policy = (await readFile(policyPath, 'utf8')).replace(/metadata: \{ \.\.\.definition.metadata, harnessToolPolicyDigest: engine.digest,[\s\S]*?harnessResultRecoveryUnavailable: true \} : \{\}\) \},/, 'metadata: { ...definition.metadata, harnessToolPolicyDigest: engine.digest },');
assert(!policy.includes('harnessResultRecoveryUnavailable')); overrides.set(policyPath, policy);
const manifest: Record<string, unknown> = { baselineCommit: git(['rev-parse', 'HEAD']).trim(),
  method: 'Same current workspace/dependencies in both bundles. Control restores four pre-optimization modules from HEAD:src, and reverts only projection wiring and recovery-denial metadata in current harness/policy. Migration and other user changes retained.', modules: {}, bundles: {} };
for (const [file, content] of overrides) {
  (manifest.modules as Record<string, unknown>)[path.relative(root, file)] = { before: hash(content), after: hash(await readFile(file)) };
  const target = path.join(directory, 'control-source', path.relative(root, file));
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
}
for (const variant of ['before', 'after']) {
  const result = await Bun.build({ entrypoints: [harnessPath], outdir: directory, naming: `${variant}.mjs`, target: 'bun', packages: 'external',
    plugins: variant === 'before' ? [{ name: 'pre-optimization-control', setup(build) { build.onLoad({ filter: /\.ts$/ }, args => {
      const contents = overrides.get(args.path); return contents === undefined ? undefined : { contents, loader: 'ts' };
    }); } }] : [] });
  assert(result.success, result.logs.map(String).join('\n'));
  (manifest.bundles as Record<string, string>)[variant] = hash(await readFile(path.join(directory, `${variant}.mjs`)));
}
await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
