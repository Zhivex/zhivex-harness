// Run from a clean npm consumer containing the exact candidate tarball. No source imports or provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ProviderToolCallError } from '@zhivex-ai/core/provider';
import { createHarness } from '@zhivex-ai/harness/engine';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget, runHarnessTask } from '@zhivex-ai/harness/code-support';

const workspace = await mkdtemp('/tmp/hu70-installed-work-');
const limits = { inputTokens: 60000, outputTokens: 8192, totalTokens: 68192 };
const pricing = { schemaVersion: 1, prices: [{ provider: 'mock', model: 'installed', inputUsdPerMillion: 0,
  outputUsdPerMillion: 1000000, source: 'synthetic fixture', asOf: '2000-01-01T00:00:00Z', expiresAt: '2100-01-01T00:00:00Z' }] };
const capabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true, toolChoice: true,
  parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false,
  reasoning: false, webSearch: false };
let calls = 0, mode = 'normal', abort;
const model = { provider: 'mock', modelId: 'installed', capabilities,
  async generate() { throw new Error('Unexpected generate'); },
  async stream() {
    calls++;
    if (mode === 'late') { abort.abort(); throw new ProviderToolCallError({ provider: 'mock', reason: 'incomplete_arguments', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, usageComplete: true, providerRequestCount: 1 }); }
    return (async function* () {
      if (mode === 'partial') throw new Error('synthetic partial failure');
      yield { type: 'text-delta', textDelta: 'fixture result' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    })();
  }
};
const contract = taskId => ({ schemaVersion: 1, taskId, allowedWritePaths: ['value.mjs'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm',
    args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'operator', requirement: 'Review fixture', status: 'pending' }] });
const open = (limitUsd = 20000) => createHarness({ workspace, provider: 'openai', modelInstance: model, subagentProfiles: [],
  unlimitedTokens: true, unlimitedSteps: true, unlimitedToolCalls: true, unlimitedDuration: true,
  usageAccounting: { pricing, limitUsd } });
let host;
const results = [];
try {
  await writeFile(workspace + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  await writeFile(workspace + '/value.mjs', 'export const value = 1;\n');
  host = await open();
  await assert.rejects(initializeHarnessTaskBudget(host, 'implicit'), /TASK_BUDGET_FINITE_LIMITS_REQUIRED/);
  await initializeHarnessTaskBudget(host, 'known', limits);
  await runHarnessTask(host, { runId: 'first', prompt: 'fixture' }, { taskAcceptance: contract('known'), taskBudgetExisting: true });
  const initial = await inspectHarnessTaskBudget(host, 'known');
  assert.equal(initial.confirmed.totalTokens, 15);
  assert.equal(initial.monetaryDetails.estimatedConfirmedUsd, 5);
  assert.equal(host.config.budget.unlimitedTokens, true);
  await host.close(); host = await open(999999);
  const revised = contract('known'); revised.humanReview[0].requirement = 'A revised review requirement';
  await runHarnessTask(host, { runId: 'revised', prompt: 'fixture correction' }, { taskAcceptance: revised, taskBudgetExisting: true });
  const reopened = await inspectHarnessTaskBudget(host, 'known');
  assert.deepEqual(reopened.limits, limits);
  assert.equal(reopened.monetary.limitUsd, 20000);
  assert.equal(reopened.confirmed.totalTokens, 30);
  assert.equal(reopened.monetary.calls, 2);
  results.push('explicit opt-in, no-cap defaults, revision and restart preserve task authority');

  await assert.rejects(inspectHarnessTaskBudget(host, 'missing'), /TASK_BUDGET_MISSING/);
  results.push('missing task authority refuses without creating credit');

  await initializeHarnessTaskBudget(host, 'unknown', limits);
  mode = 'partial';
  await assert.rejects(runHarnessTask(host, { runId: 'partial', prompt: 'fixture' }, { taskAcceptance: contract('unknown'), taskBudgetExisting: true }));
  const uncertain = await inspectHarnessTaskBudget(host, 'unknown');
  assert.equal(uncertain.usageComplete, false);
  assert.equal(uncertain.monetaryDetails.unknownCalls, 1);
  assert.ok(uncertain.monetaryDetails.unknownHeldUsd > 0);
  const before = calls;
  await host.close(); host = await open(); mode = 'normal';
  await assert.rejects(runHarnessTask(host, { runId: 'unsafe-retry', prompt: 'retry' }, { taskAcceptance: contract('unknown'), taskBudgetExisting: true }));
  assert.equal(calls, before);
  results.push('partial failure and restart retain unknown reservations; no retry dispatch');

  await initializeHarnessTaskBudget(host, 'late', limits);
  mode = 'late'; abort = new AbortController();
  await assert.rejects(runHarnessTask(host, { runId: 'late', prompt: 'fixture', abortSignal: abort.signal }, { taskAcceptance: contract('late'), taskBudgetExisting: true }));
  const late = await inspectHarnessTaskBudget(host, 'late');
  assert.equal(late.admissionsClosed, true);
  assert.equal(late.monetaryDetails.lateCalls, 1);
  assert.equal(late.monetaryDetails.estimatedConfirmedUsd, 5);
  results.push('complete late rejected-response receipt charged once without reopening admission');
  mode = 'normal';
  await host.close(); host = await open(0.0001);
  await initializeHarnessTaskBudget(host, 'exhausted', limits);
  const beforeRefusal = calls;
  await assert.rejects(runHarnessTask(host, { runId: 'refused', prompt: 'fixture' }, { taskAcceptance: contract('exhausted'), taskBudgetExisting: true }));
  assert.equal(calls, beforeRefusal);
  const refused = await inspectHarnessTaskBudget(host, 'exhausted');
  assert.equal(refused.usageComplete, true);
  assert.deepEqual(refused.remaining, limits);
  results.push('monetary exhaustion before transport releases only undispatched token reservation');
  console.log(JSON.stringify({ status: 'passed', node: process.version, calls, results, liveProvider: false }, null, 2));
} finally { await host?.close(); await rm(workspace, { recursive: true, force: true }); }
