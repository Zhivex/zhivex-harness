/** Offline-only: cannot create a provider model; reference scripts do not measure model quality. */
import assert from 'node:assert/strict';
import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPortableProcess } from '../src/execution/process-runtime.js';
import { digest, loadMinimumCohort, plannedPaidMatrix, SYNTHETIC_MODEL_SETTINGS, TASK_BUDGET } from './minimum-evals/protocol.js';
import { blindMinimumReview, runMinimumAttempt, validateMinimumFixture, type MinimumAttempt } from './minimum-evals/runner.js';

const args = process.argv.slice(2);
const value = (name: string) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const fixtureDirectory = value('fixtures') ?? process.env.ZHIVEX_MINIMUM_EVAL_FIXTURES;
assert(fixtureDirectory, 'Supply --fixtures=<private-directory> or ZHIVEX_MINIMUM_EVAL_FIXTURES; no repository default is allowed.');
const cohort = await loadMinimumCohort(path.resolve(fixtureDirectory));
const split = value('split') ?? 'holdout'; assert(['holdout', 'development'].includes(split), 'Invalid split');
const fixtures = cohort.tasks.filter(row => row.split === split);
if (args.includes('--validate')) {
  for (const fixture of fixtures) process.stdout.write(JSON.stringify(await validateMinimumFixture(fixture)) + '\n');
} else if (args.includes('--plan')) {
  assert(split === 'holdout', 'Paid matrix is only a preparation for the holdout');
  const output = value('report'); assert(output, 'Supply --report=<new-private-file.json>');
  await writeFile(output, JSON.stringify({ schemaVersion: 1, kind: 'minimum-eval-preparation', status: 'not-executed', cohort: { revision: cohort.revision, sha256: cohort.sha256 }, seed: 20261006, repetitions: 3, variants: ['rc6', 'candidate'], retryPolicy: 'none; all 72 planned attempts retained', matrix: plannedPaidMatrix(fixtures.map(row => row.id)), requiredBeforePaidExecution: ['Separate human budget approval', 'Select 12 real private tasks; this cohort is synthetic scaffolding', 'Freeze exact artifacts, model endpoint/version/settings, cache and total per-task budgets', 'Validate equivalent task ceilings; scenarios that cannot enforce RC6 task ceiling are functional-only', 'Freeze thresholds after RC6 baseline and before holdout', 'Protect hidden grader and schedule blinded human review'], modelSettings: null, paidBudgetApproval: null }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write('Prepared 72 not-executed matrix entries; no model calls.\n');
} else {
  const output = value('report'); assert(output, 'Supply --report=<new-private-file.json> (or --validate / --plan)');
  const variant = value('variant') ?? 'candidate'; assert(/^[a-z0-9-]{1,40}$/.test(variant), 'Invalid variant');
  const mode = value('mode') ?? 'reference'; assert(mode === 'reference' || mode === 'empty', 'Only synthetic reference/empty modes supported');
  const enginePath = path.resolve(value('engine') ?? fileURLToPath(new URL('../src/engine/index.ts', import.meta.url)));
  const reportPath = path.resolve(output), journalPath = reportPath + '.jsonl';
  const artifactFileDigest = digest(await readFile(enginePath));
  const engineRoot = path.dirname(path.dirname(path.dirname(enginePath)));
  const revision = await runPortableProcess(['git', 'rev-parse', 'HEAD'], { cwd: engineRoot, timeoutMs: 10_000 });
  assert(revision.exitCode === 0, 'Engine revision unavailable');
  const diff = await runPortableProcess(['git', 'diff', '--binary', 'HEAD'], { cwd: engineRoot, timeoutMs: 10_000 });
  assert(diff.exitCode === 0, 'Engine dirty-state evidence unavailable');
  const manifest = { schemaVersion: 1, kind: 'minimum-offline-task-evals', evidence: 'synthetic-runtime-only', variant, mode, split, startedAt: new Date().toISOString(), cohort: { revision: cohort.revision, sha256: cohort.sha256, provenance: cohort.provenance },
    engine: { revision: revision.stdout.trim(), moduleSha256: artifactFileDigest, dirtyDiffSha256: digest(diff.stdout), dirty: Boolean(diff.stdout) },
    environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length, dependencyLockSha256: digest(await readFile(path.join(engineRoot, 'bun.lock'))), dependencyResolution: process.env.NODE_PATH ? 'explicit-NODE_PATH' : 'engine-checkout', bun: Bun.version, node: process.version, cache: 'fresh-workspaces; process/import warm after first task; OS cache uncontrolled', resourcePolicy: 'serial-one-writer-one-attempt' },
    modelSettings: SYNTHETIC_MODEL_SETTINGS, budget: TASK_BUDGET, budgetEquivalence: 'One run with durable approval resume. Additional fresh-run/revise ceiling differences require separate functional evidence, excluded from cost A/B.',
    retryPolicy: 'none; every attempted failure preserved', plannedAttempts: fixtures.length, paidCalls: 0,
    limitations: ['Synthetic models detect runtime regressions, not model quality', 'Scaffolding tasks are not real privately sourced holdout tasks', 'Hidden grader is outside the agent workspace, with exact regular-file copying; host execution is not an adversarial sandbox', 'Human review pending; automatedPass is not acceptedChange', 'Synthetic token counts are not provider billing; no cost or competitive claim', 'Durable report journals do not claim exactly-once arbitrary external API execution'] };
  await writeFile(reportPath, JSON.stringify({ ...manifest, status: 'running' }) + '\n', { flag: 'wx', mode: 0o600 });
  const journal = await open(journalPath, 'wx', 0o600);
  const rows: MinimumAttempt[] = [];
  const blindReviews: ReturnType<typeof blindMinimumReview>[] = [];
  try {
    const api: typeof import('../src/engine/index.js') = await import(pathToFileURL(enginePath).href);
    for (const fixture of fixtures) {
      const row = await runMinimumAttempt(api, fixture, variant, mode);
      rows.push(row); blindReviews.push(blindMinimumReview(fixture, row)); await journal.writeFile(JSON.stringify({ cohortSha256: cohort.sha256, engine: manifest.engine, ...row }) + '\n'); await journal.sync();
      process.stdout.write(`${fixture.id}: ${row.automatedPass ? 'automated-pass (human pending)' : 'failed ' + row.failureClass}\n`);
    }
    await writeFile(reportPath + '.blind-review.json', JSON.stringify({ schemaVersion: 1, reviews: blindReviews }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const automatedPass = rows.filter(row => row.automatedPass).length;
    await writeFile(reportPath, JSON.stringify({ ...manifest, status: 'completed', finishedAt: new Date().toISOString(), counts: { planned: fixtures.length, executed: rows.length, automatedPass, humanAccepted: 0, failed: rows.length - automatedPass }, rows }, null, 2) + '\n');
    if (mode === 'reference' && automatedPass !== fixtures.length || mode === 'empty' && automatedPass !== 0) process.exitCode = 1;
  } catch {
    await writeFile(reportPath, JSON.stringify({ ...manifest, status: 'infrastructure-failed', diagnostic: 'SETUP_OR_CAMPAIGN_FAILURE', executed: rows.length, rows }, null, 2) + '\n');
    process.stderr.write('Offline campaign failed; report and journal retained.\n'); process.exitCode = 1;
  } finally { await journal.close(); }
}
