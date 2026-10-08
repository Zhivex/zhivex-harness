import { beforeAll, afterAll, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { agentFixture, loadMinimumCohort, plannedPaidMatrix, digest } from '../scripts/minimum-evals/protocol.js';
import { blindMinimumReview, validateMinimumFixture, runMinimumAttempt, gradeMinimumSubmission } from '../scripts/minimum-evals/runner.js';
import { writePublicRegressionCohort } from '../scripts/minimum-evals/public-regression-fixtures.js';
import * as engine from '../src/engine/index.js';

let publicDirectory: string;
beforeAll(async () => { publicDirectory = await mkdtemp('/tmp/har-public-eval-contract-'); await writePublicRegressionCohort(publicDirectory); });
afterAll(async () => { await rm(publicDirectory, { recursive: true, force: true }); });

test('public generated 12 contract tasks span three repos; two dev tasks stay separate', async () => {
  const cohort = await loadMinimumCohort(publicDirectory);
  expect(cohort.tasks.filter(row => row.split === 'holdout')).toHaveLength(12);
  expect(cohort.tasks.filter(row => row.split === 'development')).toHaveLength(2);
  const schedule = plannedPaidMatrix(cohort.tasks.filter(row => row.split === 'holdout').map(row => row.id));
  expect(schedule).toHaveLength(72);
  expect(new Set(schedule.map(row => `${row.fixtureId}/${row.variant}/${row.repetition}`)).size).toBe(72);
  expect(schedule.every(row => row.status === 'not-executed')).toBe(true);
  expect(plannedPaidMatrix(cohort.tasks.filter(row => row.split === 'holdout').map(row => row.id))).toEqual(schedule);
});

test('hidden oracle/reference and rubric never enter materialized task context', async () => {
  const cohort = await loadMinimumCohort(publicDirectory);
  for (const fixture of cohort.tasks) {
    const exposed = agentFixture(fixture);
    expect(Object.keys(exposed)).not.toContain('oracle');
    expect(Object.keys(exposed)).not.toContain('reference');
    expect(Object.keys(exposed.files)).not.toContain('hidden-acceptance.ts');
    for (const [name, reference] of Object.entries(fixture.reference)) expect(exposed.files[name]).not.toBe(reference);
  }
});

test('frozen digest rejects a changed fixture before any model execution', async () => {
  const root = await mkdtemp('/tmp/har-eval-digest-');
  try { await writeFile(root + '/cohort.json', '{}'); await writeFile(root + '/cohort.sha256', digest('different')); await expect(loadMinimumCohort(root)).rejects.toThrow('DIGEST_MISMATCH'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('public regression references pass, all empty patches fail protected and public checks', async () => {
  const cohort = await loadMinimumCohort(publicDirectory);
  for (const fixture of cohort.tasks) expect(await validateMinimumFixture(fixture)).toEqual({ fixtureId: fixture.id, emptyPassed: false, referencePassed: true });
}, 30_000);

test('native task synthetic reference passes; empty completion remains failure and pending human review', async () => {
  const fixture = (await loadMinimumCohort(publicDirectory)).tasks.find(row => row.id === 'public-a')!;
  const reference = await runMinimumAttempt(engine, fixture, 'candidate');
  expect(reference.diagnostics).toEqual([]);
  const review = blindMinimumReview(fixture, reference);
  expect(JSON.stringify(review)).not.toContain('candidate');
  expect(review).not.toHaveProperty('modelSettings');
  expect(review).not.toHaveProperty('latency');
  expect(review.decision).toBeNull();
  expect(reference).toMatchObject({ runCompleted: true, oraclePassed: true, scopePassed: true, protectedFilesUnchanged: true, automatedPass: true, acceptedChange: null, humanReview: { status: 'pending' }, failureClass: 'none' });
  const empty = await runMinimumAttempt(engine, fixture, 'candidate', 'empty');
  expect(empty).toMatchObject({ runCompleted: true, oraclePassed: false, automatedPass: false, acceptedChange: null, failureClass: 'oracle' });
}, 30_000);

test('native task restores durable approval after reopen with same scripted model', async () => {
  const fixture = (await loadMinimumCohort(publicDirectory)).tasks.find(row => row.id === 'public-restart')!;
  const result = await runMinimumAttempt(engine, fixture, 'candidate');
  expect(result.diagnostics).toEqual([]);
  expect(result).toMatchObject({ restarted: true, automatedPass: true });
}, 30_000);

test('clean verifier grades original protected checks even after submission tampering', async () => {
  const fixture = (await loadMinimumCohort(publicDirectory)).tasks[0]!;
  const root = await mkdtemp('/tmp/har-eval-tamper-');
  try {
    const workspace = root + '/agent'; await mkdir(workspace + '/src', { recursive: true });
    for (const [name, bytes] of Object.entries(agentFixture(fixture).files)) await writeFile(workspace + '/' + name, bytes);
    for (const [name, bytes] of Object.entries(fixture.reference)) await writeFile(workspace + '/' + name, bytes);
    await writeFile(workspace + '/public-check.ts', 'process.exit(0);');
    await writeFile(workspace + '/extra.txt', 'unauthorized');
    const result = await gradeMinimumSubmission(fixture, workspace, root + '/grader');
    expect(result).toMatchObject({ oraclePassed: true, protectedFilesUnchanged: false, scopePassed: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private catalog and evaluation runner remain outside npm package file allowlist', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['.private-minimum-evals/cohort.json', '.private-minimum-evals/cohort.sha256', 'scripts/minimum-evals/runner.ts', 'scripts/minimum-task-evals.ts']) {
    expect(manifest.files.some((pattern: string) => name === pattern || name.startsWith(pattern + '/') || new Bun.Glob(pattern).match(name))).toBe(false);
  }
});
