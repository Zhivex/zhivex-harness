// Exact-tarball offline consumer; no source aliases or paid provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHarness } from '@zhivex-ai/harness/engine';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget, requestHarnessTaskCancellation, runHarnessTask } from '@zhivex-ai/harness/code-support';
const workspace = await mkdtemp('/tmp/hu71-installed-work-');
const limits = { inputTokens: 60000, outputTokens: 8192, totalTokens: 68192 };
const barrier = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
const capabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true, toolChoice: true,
  parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false,
  reasoning: false, webSearch: false };
const contract = taskId => ({ schemaVersion: 1, taskId, allowedWritePaths: ['value.mjs'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm',
    args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'operator', requirement: 'Review fixture', status: 'pending' }] });

const results = []; let host;
try {
  await writeFile(workspace + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  for (const receipt of [false, true]) {
    const entered = barrier(), finish = barrier();
    const model = { provider: 'mock', modelId: 'installed', capabilities,
      async generate() { throw new Error('Unexpected generate'); },
      async stream(input) { return (async function* () {
        yield { type: 'text-delta', textDelta: 'partial work' }; entered.release(); await finish.promise;
        if (!receipt) throw input.abortSignal.reason;
        yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      })(); }
    };
    const open = () => createHarness({ workspace, modelInstance: model, subagentProfiles: [], usageAccounting: {}, unlimitedTokens: true });
    host = await open(); const id = receipt ? 'complete' : 'unknown';
    await initializeHarnessTaskBudget(host, id, limits);
    const pending = runHarnessTask(host, { runId: id, prompt: 'fixture' }, { taskAcceptance: contract(id), taskBudgetExisting: true });
    pending.catch(() => {}); await entered.promise;
    const requested = await requestHarnessTaskCancellation(host, id, id);
    assert.equal(requested.admissionsClosed, true);
    assert.equal(requested.invocationPending, true);
    assert.equal(requested.cancellations[0].localExecution, 'unconfirmed');
    assert.equal(requested.cancellations[0].remoteExecution, 'unconfirmed');
    await requestHarnessTaskCancellation(host, id, id);
    finish.release(); await pending.catch(() => {});
    const settled = await inspectHarnessTaskBudget(host, id);
    assert.equal(settled.cancellations.length, 1);
    assert.equal(settled.cancellations[0].localExecution, 'native_tools_drained');
    assert.equal(settled.cancellations[0].remoteExecution, 'unconfirmed');
    assert.equal(settled.invocationPending, false);
    assert.equal(settled.usageComplete, receipt);
    if (receipt) assert.equal(settled.confirmed.totalTokens, 15);
    else assert.ok(settled.unknown.totalTokens > 0);
    assert.equal(host.config.budget.unlimitedTokens, true);
    await host.close(); host = await open();
    assert.deepEqual(await inspectHarnessTaskBudget(host, id), settled);
    await assert.rejects(runHarnessTask(host, { runId: id + '-late', prompt: 'late' }, { taskAcceptance: contract(id), taskBudgetExisting: true }), /TASK_BUDGET_CANCELLED/);
    results.push(receipt ? 'late complete receipt retained across restart; no reopening' : 'unknown exposure retained across restart; no optimistic refund');
    await host.close(); host = undefined;
  }
  console.log(JSON.stringify({ status: 'passed', node: process.version, results, liveProvider: false }, null, 2));
} finally { await host?.close(); await rm(workspace, { recursive: true, force: true }); }
