import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createTextMessage } from '@zhivex-ai/core';
import { createHarness, runHarnessTask } from '../src/runtime/harness.js';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget, requestHarnessTaskCancellation } from '../src/runtime/task-budget-host.js';
import { cancelHarnessRun } from '../src/persistence/operations.js';
import { TASK_ACCEPTANCE_EVIDENCE_KEY } from '../src/runtime/task-acceptance-record.js';
import { taskAcceptanceContractSchema } from '../src/runtime/task-acceptance.js';

const contract = taskAcceptanceContractSchema.parse({ schemaVersion: 1, taskId: 'cancel', allowedWritePaths: ['result.txt'], protectedFiles: [],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'human', requirement: 'Review', status: 'pending' }] });
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const barrier = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp('/tmp/task-cancel-host-');
  try { await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } })); await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const receipt of [false, true]) test(`stream cancellation keeps ${receipt ? 'late complete receipt' : 'unknown exposure'} across host restart`, () => fixture(async root => {
  const entered = barrier(), finish = barrier();
  const model = createMockLanguageModel();
  model.stream = async input => (async function* () {
    yield { type: 'text-delta' as const, textDelta: 'partial work' }; entered.release(); await finish.promise;
    if (!receipt) throw input.abortSignal!.reason;
    yield { type: 'finish' as const, finishReason: 'stop' as const, usage };
  })();
  let host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model });
  try {
    await initializeHarnessTaskBudget(host, contract.taskId);
    const pending = runHarnessTask(host, { runId: 'stream', prompt: 'fixture' }, { taskAcceptance: contract, taskBudgetExisting: true });
    pending.catch(() => {}); await entered.promise;
    const requested = await requestHarnessTaskCancellation(host, contract.taskId, 'stream');
    expect(requested).toMatchObject({ admissionsClosed: true, invocationPending: true });
    expect(requested.cancellations).toMatchObject([{ origin: 'operator', localExecution: 'unconfirmed', remoteExecution: 'unconfirmed' }]);
    finish.release(); await pending.catch(() => {});
    const result = await inspectHarnessTaskBudget(host, contract.taskId);
    expect(result.invocationPending).toBe(false);
    expect(result.admissionsClosed).toBe(true);
    expect(result.usageComplete).toBe(receipt);
    if (receipt) expect(result.confirmed).toEqual(usage);
    else expect(result.unknown.totalTokens).toBeGreaterThan(0);
    const state = await host.store.load('stream', host.config.scope);
    expect((state?.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY] as any)?.status).not.toBe('accepted');
    await host.close(); host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model });
    expect(await inspectHarnessTaskBudget(host, contract.taskId)).toEqual(result);
    await expect(runHarnessTask(host, { runId: 'late', prompt: 'late approval must not reopen' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_BUDGET_CANCELLED');
  } finally { finish.release(); await host.close(); }
}));

test('cancel waiting approval closes task authority; stale and freshly reloaded approvals cannot execute', () => fixture(async root => {
  const model = createMockLanguageModel({ streamEvents: [[
    { type: 'tool-call', toolCall: { id: 'write', name: 'apply_reviewed_edits', input: { changes: [{ path: 'result.txt', expectedDigest: null, content: 'must not happen' }] } } },
    { type: 'finish', finishReason: 'tool-calls', usage }
  ]] });
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model });
  try {
    await initializeHarnessTaskBudget(host, contract.taskId);
    const waiting = await runHarnessTask(host, { runId: 'approval', prompt: 'fixture' }, { taskAcceptance: contract, taskBudgetExisting: true });
    expect(waiting.status).toBe('waiting_approval');
    const before = await inspectHarnessTaskBudget(host, contract.taskId);
    await cancelHarnessRun(host.store, host.config, 'approval', { final: true });
    const cancelled = (await host.store.load('approval', host.config.scope))!;
    expect(cancelled.status).toBe('cancelled');
    for (const state of [waiting.state, cancelled]) {
      await expect(runHarnessTask(host, { state, approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) }, { taskBudgetExisting: true })).rejects.toThrow();
    }
    expect(await Bun.file(root + '/result.txt').exists()).toBe(false);
    const after = await inspectHarnessTaskBudget(host, contract.taskId);
    expect(after.confirmed).toEqual(before.confirmed); expect(after.monetary).toEqual(before.monetary);
    expect(after.admissionsClosed).toBe(true);
  } finally { await host.close(); }
}));

test('cancellation during actual semantic compaction admits no primary model and retains utility exposure', () => fixture(async root => {
  const entered = barrier(), finish = barrier(); let primary = 0;
  const model = createMockLanguageModel(); model.stream = async () => { primary++; throw new Error('primary must not start'); };
  const utility = createMockLanguageModel(); utility.generate = async input => { entered.release(); await finish.promise; throw input.abortSignal!.reason; };
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model,
    compactionModel: 'mock-utility', compactionModelInstance: utility, compactionMaxMessages: 4, compactionKeepRecentMessages: 2 });
  try {
    await initializeHarnessTaskBudget(host, contract.taskId);
    const pending = runHarnessTask(host, { runId: 'compact', messages: [createTextMessage('user', 'Preserve compatibility. '.repeat(1500)),
      createTextMessage('assistant', 'Inspected the interface. '.repeat(200)), createTextMessage('user', 'Proceed'), createTextMessage('assistant', 'Inspect'), createTextMessage('user', 'Continue')] }, { taskAcceptance: contract, taskBudgetExisting: true });
    pending.catch(() => {}); await entered.promise;
    await requestHarnessTaskCancellation(host, contract.taskId, 'compact'); finish.release(); await pending.catch(() => {});
    expect(primary).toBe(0);
    expect(await inspectHarnessTaskBudget(host, contract.taskId)).toMatchObject({ admissionsClosed: true, usageComplete: false,
      monetaryDetails: { unknownCalls: 1, categories: ['compaction'] } });
  } finally { finish.release(); await host.close(); }
}));

test('completed work returns already_terminal without closing future task admissions', () => fixture(async root => {
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'finish', finishReason: 'stop', usage }]] }) });
  try {
    await initializeHarnessTaskBudget(host, contract.taskId);
    await runHarnessTask(host, { runId: 'done', prompt: 'fixture' }, { taskAcceptance: contract, taskBudgetExisting: true });
    const before = await host.store.load('done', host.config.scope);
    expect(await requestHarnessTaskCancellation(host, contract.taskId, 'done')).toMatchObject({ requestOutcome: 'already_terminal', executionStatus: 'completed', admissionsClosed: false, cancellations: [] });
    expect(await host.store.load('done', host.config.scope)).toEqual(before);
    await expect(requestHarnessTaskCancellation(host, contract.taskId, 'unrelated')).rejects.toThrow('TASK_BUDGET_RUN_BINDING_MISSING');
  } finally { await host.close(); }
}));
