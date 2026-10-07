// Offline exact-package consumer. No source aliases or real providers.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHarness, reviseHarnessTaskAcceptance } from '@zhivex-ai/harness/engine';
import { initializeHarnessTaskBudget, inspectHarnessTaskContinuity, runHarnessTask } from '@zhivex-ai/harness/code-support';
const root = await mkdtemp('/tmp/hu72-installed-');
const capabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true, toolChoice: true,
  parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false };
let requests = 0;
const model = { provider: 'mock', modelId: 'continuity-consumer', capabilities,
  async generate() { throw new Error('Unexpected generate'); },
  async stream() { requests++; return (async function* () {
    yield { type: 'text-delta', textDelta: 'Offline observation' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  })(); } };
const contract = { schemaVersion: 1, taskId: 'installed-continuity', allowedWritePaths: ['value.txt'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'human', requirement: 'Review result', status: 'pending' }] };
const open = () => createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model });
let host;
try {
  await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  await writeFile(root + '/value.txt', 'original');
  host = await open();
  await initializeHarnessTaskBudget(host, contract.taskId);
  await runHarnessTask(host, { runId: 'first', prompt: 'Preserve this objective across restart' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = await host.store.load('first', host.config.scope);
  const revised = { ...contract, humanReview: [{ id: 'human', requirement: 'Authorized revised requirement', status: 'pending' }] };
  await reviseHarnessTaskAcceptance(host, { runId: 'first', expectedRunRevision: state.revision, expectedContractRevision: 1, contract: revised });
  await assert.rejects(runHarnessTask(host, { runId: 'stale', prompt: 'Old brief' }, { taskAcceptance: contract, taskBudgetExisting: true }), /TASK_CONTINUITY_CONTRACT_CONFLICT/);
  assert.equal(requests, 1);
  await host.close(); host = await open();
  await runHarnessTask(host, { runId: 'second', prompt: 'Continue revised requirement' }, { taskAcceptance: revised, taskBudgetExisting: true });
  const recovered = await inspectHarnessTaskContinuity(host, contract.taskId);
  assert.equal(recovered.currentContract.revision, 2);
  assert.equal(recovered.budget.confirmed.totalTokens, 30);
  assert.ok(recovered.runs.at(-1).sources.some(source => source.text === 'Preserve this objective across restart'));
  assert.equal(recovered.automaticEffectReplay, false);
  await host.store.saveToolCall({ runId: 'second', scope: host.config.scope, toolCallId: 'uncertain', toolName: 'apply_reviewed_edits', status: 'running', revision: 1, idempotencyKey: 'uncertain', updatedAt: 1 });
  await assert.rejects(runHarnessTask(host, { runId: 'blocked', prompt: 'No replay' }, { taskAcceptance: revised, taskBudgetExisting: true }), /TASK_CONTINUITY_EFFECT_UNCERTAIN/);
  assert.equal(requests, 2);
  assert.equal((await inspectHarnessTaskContinuity(host, contract.taskId)).budget.confirmed.totalTokens, 30);
  console.log(JSON.stringify({ status: 'passed', node: process.version, bun: globalThis.Bun?.version ?? null, requests, liveProvider: false,
    cases: ['stale contract refused before dispatch', 'revision and objective retained across restart', 'budget retained', 'uncertain effect blocks replay'] }, null, 2));
} finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
