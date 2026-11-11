import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { assistantEvaluationSuiteSchema, planAssistantEvaluation } from '../src/evaluation.js';
import { taskMetricsPricingSchema } from '../src/task-metrics.js';

const suite = JSON.parse(await readFile(new URL('../evaluations/tasks.v1.json', import.meta.url), 'utf8'));
test('initial evaluation matrix includes 30 cases and 90 unexecuted trials with reproducible identity', () => {
  const plan = planAssistantEvaluation(suite);
  expect(plan.trials).toHaveLength(90);
  expect(new Set(plan.trials.map(t => t.trialId)).size).toBe(90);
  expect(new Set(plan.trials.map(t => t.category)).size).toBe(6);
  expect(plan.trials.every(t => t.outcome === null && t.estimatedUsd === null && t.checks.every(c => c.passed === null))).toBe(true);
  expect(planAssistantEvaluation(suite).suiteSha256).toBe(plan.suiteSha256);
  expect(planAssistantEvaluation({ ...suite, revision: '2' }).suiteSha256).not.toBe(plan.suiteSha256);
  expect(() => assistantEvaluationSuiteSchema.parse({ ...suite, cases: [...suite.cases, suite.cases[0]] })).toThrow();
  expect(() => planAssistantEvaluation(suite, 0)).toThrow();
});

test('explicit price configuration rejects ambiguous, non-finite and invalid dates', () => {
  const price = { provider: 'test', model: 'test', inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    source: 'test-only', asOf: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' };
  expect(taskMetricsPricingSchema.parse({ schemaVersion: 1, prices: [price] }).prices).toHaveLength(1);
  for (const prices of [[price, price], [{ ...price, outputUsdPerMillion: -1 }], [{ ...price, expiresAt: price.asOf }]]) {
    expect(() => taskMetricsPricingSchema.parse({ schemaVersion: 1, prices })).toThrow();
  }
});
