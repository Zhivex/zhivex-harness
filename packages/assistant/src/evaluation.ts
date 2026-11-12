import { z } from 'zod';
import { createHash } from 'node:crypto';
import { taskCategorySchema } from './task-metrics.js';

const text = z.string().trim().min(1).max(4000);
export const assistantEvaluationSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1), id: text, revision: text,
  environment: z.strictObject({ now: z.string().datetime(), timeZone: text, setup: z.array(text).min(1) }),
  cases: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), category: taskCategorySchema,
    setup: text, turns: z.array(text).min(1), checks: z.array(text).min(1),
    verification: z.enum(['state-inspection', 'human-review', 'delivery-inspection']),
    faultInjection: text.optional()
  })).min(1).max(200)
}).superRefine((suite, context) => {
  if (new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) context.addIssue({ code: 'custom', message: 'Duplicate evaluation case ID' });
});

/** Preparation only: no model calls, external mutations or synthetic success claims. */
export function planAssistantEvaluation(input: unknown, repetitions = 3) {
  const suite = assistantEvaluationSuiteSchema.parse(input);
  z.number().int().min(1).max(10).parse(repetitions);
  return {
    schemaVersion: 1, kind: 'assistant-evaluation-plan', status: 'not-executed',
    suiteId: suite.id, revision: suite.revision,
    suiteSha256: createHash('sha256').update(JSON.stringify(suite)).digest('hex'),
    repetitions, environment: suite.environment,
    configuration: { product: null, artifactRevision: null, provider: null, model: null, pricingSource: null,
      taskTimeoutMs: null, taskBudgetUsd: null, toolConfigurationDigest: null },
    policy: { retries: 'Record every attempt; never replace failures with retries',
      isolation: 'Reset fixtures and use a fresh session for every trial',
      grading: 'All listed checks must pass with retained evidence; missing evidence is unverified',
      unsupported: 'Record unsupported separately; include it in product coverage',
      approval: 'Only the test operator approves actions against controlled test accounts' },
    trials: suite.cases.flatMap(c => Array.from({ length: repetitions }, (_, index) => ({
      trialId: `${c.id}:${index + 1}`, caseId: c.id, repetition: index + 1, category: c.category,
      status: 'not-executed', taskId: null, outcome: null, durationMs: null, corrections: null,
      estimatedUsd: null, costComplete: null,
      checks: c.checks.map(check => ({ check, passed: null, evidenceRef: null }))
    })))
  };
}
