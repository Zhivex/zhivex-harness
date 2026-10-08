import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const exactPath = z.string().regex(/^(src|docs)\/[A-Za-z0-9._/-]+$/).refine(value => !value.split('/').some(part => !part || part === '.' || part === '..'));
const taskSchema = z.strictObject({
  id: z.string().regex(/^[a-z-]+$/), repository: z.string(), split: z.enum(['holdout', 'development']),
  mode: z.enum(['repair', 'long-context', 'restart']), files: z.record(exactPath, z.string()), editable: z.array(exactPath).min(1),
  instructions: z.string(), publicCheck: z.string(), oracle: z.string(), reference: z.record(exactPath, z.string()),
  constraints: z.array(z.string()), rubric: z.strictObject({ correctness: z.string(), scope: z.string(), review: z.string() })
}).superRefine((task, ctx) => {
  if (new Set(task.editable).size !== task.editable.length || Object.keys(task.reference).sort().join() !== [...task.editable].sort().join() || task.editable.some(name => !(name in task.files))) ctx.addIssue({ code: 'custom', message: 'Invalid exact edit/reference set' });
});
export type MinimumFixture = z.infer<typeof taskSchema>;
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const TASK_BUDGET = Object.freeze({ timeoutMs: 30_000, maxSteps: 12, maxToolCalls: 16, maxInputTokens: 20_000, maxOutputTokens: 8192, maxTotalTokens: 28_192 });
export const SYNTHETIC_MODEL_SETTINGS = Object.freeze({ provider: 'synthetic', model: 'scripted-reference-v1', endpoint: null, reasoning: 'none', temperature: null, maxOutputTokens: TASK_BUDGET.maxOutputTokens, tools: ['apply_reviewed_edits', 'run_check'], policy: 'exact-task-allowlist', cache: 'fresh-workspace', network: 'none' });

export async function loadMinimumCohort(directory: string) {
  const content = await readFile(directory + '/cohort.json', 'utf8');
  const expected = (await readFile(directory + '/cohort.sha256', 'utf8')).trim();
  if (digest(content) !== expected) throw new Error('MINIMUM_FIXTURE_DIGEST_MISMATCH');
  const cohort = z.strictObject({ schemaVersion: z.literal(1), revision: z.literal('minimum-synthetic-js-ts-v1'), provenance: z.string(), repositories: z.array(z.string()).length(3), tasks: z.array(taskSchema).length(14) }).parse(JSON.parse(content));
  if (new Set(cohort.tasks.map(task => task.id)).size !== 14 || cohort.tasks.filter(task => task.split === 'holdout').length !== 12 || cohort.tasks.filter(task => task.split === 'development').length !== 2 || cohort.repositories.some(repo => cohort.tasks.filter(task => task.split === 'holdout' && task.repository === repo).length !== 4)) throw new Error('MINIMUM_FIXTURE_COHORT_MISMATCH');
  return { ...cohort, sha256: expected };
}

/** Deliberately omits hidden acceptance and reference bytes from everything sent to a task. */
export function agentFixture(fixture: MinimumFixture) {
  const files: Record<string, string> = { ...fixture.files, 'public-check.ts': fixture.publicCheck,
    'package.json': JSON.stringify({ private: true, type: 'module', packageManager: 'bun@1.4.0', scripts: { test: 'bun --no-env-file public-check.ts' } }) };
  return { id: fixture.id, instructions: fixture.instructions, files,
    acceptance: { schemaVersion: 1 as const, taskId: fixture.id, allowedWritePaths: fixture.editable, protectedFiles: ['package.json', 'public-check.ts', ...Object.keys(fixture.files).filter(name => !fixture.editable.includes(name))],
      requiredChecks: [{ id: 'public-test', kind: 'package-script' as const, script: 'test', expectedScript: 'bun --no-env-file public-check.ts', command: 'bun', args: ['--no-env-file', 'run', 'test'], purpose: 'Frozen visible regression test', execution: { backend: 'none' as const, approval: 'required' as const } }],
      humanReview: [{ id: 'readability', requirement: fixture.rubric.review, status: 'pending' as const }] } };
}

/** Preparation only. This function never creates a model or invokes a provider. */
export function plannedPaidMatrix(ids: readonly string[], seed = 20261006) {
  if (ids.length !== 12 || new Set(ids).size !== 12) throw new Error('MINIMUM_MATRIX_REQUIRES_12_HOLDOUT_TASKS');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const ordered = [...ids];
  for (let i = ordered.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]; }
  return Array.from({ length: 3 }, (_, index) => index + 1).flatMap(repetition => ordered.flatMap((fixtureId, index) => ((index + repetition) % 2 ? ['candidate', 'rc6'] : ['rc6', 'candidate']).map(variant => ({ fixtureId, repetition, attempt: 1, variant, status: 'not-executed' as const }))));
}
