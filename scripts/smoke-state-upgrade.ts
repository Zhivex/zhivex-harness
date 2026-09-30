// Explicit historical artifact -> candidate acceptance. Never edits stored fingerprints.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [oldInput, newInput, expectation = 'incompatible'] = process.argv.slice(2);
assert(['compatible', 'incompatible'].includes(expectation), 'Expected compatible or incompatible');
assert(oldInput && newInput, 'Provide historical and candidate Harness tarballs');
const runtime = process.env.HARNESS_COMPAT_RUNTIME ?? 'node';
const root = await mkdtemp(path.join(os.tmpdir(), 'harness-state-upgrade-'));
const workspace = path.join(root, 'workspace'); await mkdir(workspace);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(API_KEY|TOKEN|BASE_URL)$/.test(key)) delete env[key];
function run(command: string, args: string[], cwd: string, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const artifacts = [];
for (const [label, input] of [['historical', oldInput], ['candidate', newInput]] as const) {
  const consumer = path.join(root, label); await mkdir(consumer);
  const artifact = path.resolve(input);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { '@zhivex-ai/harness': `file:${artifact}` } }));
  run('bun', ['install', '--ignore-scripts'], consumer);
  const manifest = JSON.parse(await readFile(path.join(consumer, 'node_modules/@zhivex-ai/harness/package.json'), 'utf8'));
  await copyFile(path.resolve(import.meta.dir, 'installed-engine-consumer.mjs'), path.join(consumer, 'fixture.mjs'));
  artifacts.push({ label, version: manifest.version, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') });
}
assert.notEqual(artifacts[0]!.sha256, artifacts[1]!.sha256, 'Compare distinct artifact bytes, not the same package twice');
const fixture = (label: string, phase: string, legacy = false) => run(runtime, [path.join(root, label, 'fixture.mjs'), phase], workspace,
  { HARNESS_COMPAT_ROOT: legacy ? '1' : '0' });
try {
  fixture('historical', 'session-create', true);
  fixture('candidate', 'session-inspect');
  fixture('historical', 'session-inspect', true);
  fixture('historical', 'create', true);
  if (expectation === 'compatible') {
    fixture('candidate', 'inspect-compatible');
    fixture('candidate', 'resume');
  } else {
    fixture('candidate', 'reject-incompatible');
    // Rejection leaves the old version able to resume with explicit approval.
    fixture('historical', 'resume', true);
  }
  const report = { status: 'passed', expectation, artifacts, runtime: { executable: runtime, version: run(runtime, ['--version'], root).trim() },
    checks: expectation === 'compatible' ? ['historical-session-preserved', 'historical-pending-approval', 'unchanged-compatible-binding',
      'no-effect-on-open', 'candidate-explicit-resume'] : ['historical-session-preserved', 'historical-pending-approval', 'candidate-rejects-version-mismatch', 'no-model-or-file-effect',
      'pending-state-preserved', 'historical-explicit-resume'], root };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Failed compatibility evidence retained at ${root}`); throw error;
}
