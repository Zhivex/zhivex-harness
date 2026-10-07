import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, cp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, runHarnessTask } from '../src/runtime/harness.js';
import { initializeHarnessTaskBudget } from '../src/runtime/task-budget-host.js';
import { reviseHarnessTaskAcceptance } from '../src/runtime/task-acceptance-host.js';
import { taskAcceptanceContractSchema } from '../src/runtime/task-acceptance.js';
import type { StreamEvent } from '@zhivex-ai/core';
import { inspectHarnessTaskContinuity } from '../src/runtime/task-continuity.js';
import { TASK_ACCEPTANCE_KEY, TASK_ACCEPTANCE_EVIDENCE_KEY } from '../src/runtime/task-acceptance-record.js';
import { persistHarnessTaskDraft, readHarnessTaskDraft, inspectHarnessTaskBudget } from '../src/runtime/task-budget-host.js';
import { SqliteDatabase } from '../src/persistence/sqlite-database.js';
import { createHarnessStateBackup, importHarnessStateBackup } from '../src/persistence/state-backup.js';
import { createTextMessage } from '@zhivex-ai/core';
import { openHarnessTaskBudget } from '../src/runtime/task-budget-host.js';
import { TASK_BUDGET_KEY } from '../src/runtime/task-budget.js';

const contract = taskAcceptanceContractSchema.parse({ schemaVersion: 1, taskId: 'continuity', allowedWritePaths: ['result.txt'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'human', requirement: 'Review result', status: 'pending' }] });
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const done: StreamEvent[] = [{ type: 'text-delta', textDelta: 'Observed' }, { type: 'finish', finishReason: 'stop', usage }];
async function fixture(work: (host: Awaited<ReturnType<typeof createHarness>>, root: string) => Promise<void>, events: StreamEvent[][] = [done, done]) {
  const root = await mkdtemp('/tmp/task-continuity-');
  await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  await writeFile(root + '/result.txt', 'original');
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: events }) });
  try { await initializeHarnessTaskBudget(host, contract.taskId); await work(host, root); }
  finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}
test('new task turn cannot silently replace an authorized durable contract revision with a stale brief', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Original objective' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('first', host.config.scope))!;
  await reviseHarnessTaskAcceptance(host, { runId: 'first', expectedRunRevision: state.revision!, expectedContractRevision: 1,
    contract: { ...contract, humanReview: [{ id: 'human', requirement: 'Authorized revised objective', status: 'pending' }] } });
  await expect(runHarnessTask(host, { runId: 'next', prompt: 'Continue old brief' }, { taskAcceptance: contract, taskBudgetExisting: true, taskBudgetContinue: true }))
    .rejects.toThrow('TASK_CONTINUITY_CONTRACT_CONFLICT');
  expect(await host.store.load('next', host.config.scope)).toBeUndefined();
}));

test('authorized revision and original objective survive a new run and fresh host without resetting budget', () => fixture(async (host, root) => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Original objective and constraints' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const first = (await host.store.load('first', host.config.scope))!;
  const revised = { ...contract, humanReview: [{ id: 'human', requirement: 'Revised review', status: 'pending' as const }] };
  await reviseHarnessTaskAcceptance(host, { runId: 'first', expectedRunRevision: first.revision!, expectedContractRevision: 1, contract: revised });
  await runHarnessTask(host, { runId: 'second', prompt: 'Continue' }, { taskAcceptance: revised, taskBudgetExisting: true });
  const result = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(result.currentContract?.revision).toBe(2);
  expect(result.runs.at(-1)?.sources.some(source => source.text === 'Original objective and constraints')).toBe(true);
  expect(result.budget.confirmed.totalTokens).toBe(30);
  expect(result.automaticEffectReplay).toBe(false);
  await host.close();
  const restarted = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  try { expect(await inspectHarnessTaskContinuity(restarted, contract.taskId)).toEqual(result); }
  finally { await restarted.close(); }
}));

for (const status of ['running', 'failed', 'completed'] as const) test(`effect ${status} before/after receipt is classified without replay`, () => fixture(async (host, root) => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Inspect result' }, { taskAcceptance: contract, taskBudgetExisting: true });
  await writeFile(root + '/result.txt', 'effect already happened');
  await host.store.saveToolCall!({ runId: 'first', scope: host.config.scope, toolCallId: 'effect', providerToolCallId: 'effect', toolName: 'apply_reviewed_edits',
    revision: 1, idempotencyKey: 'effect', status, startedAt: 10, updatedAt: 20,
    ...(status === 'completed' ? { completedAt: 20, output: { recorded: true } } : {}) });
  const before = await inspectHarnessTaskBudget(host, contract.taskId);
  const result = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(result.runs[0]?.effects[0]?.retry).toBe('never_automatic');
  expect(result.reasons.includes('TASK_CONTINUITY_EFFECT_UNCERTAIN')).toBe(status !== 'completed');
  if (status !== 'completed') await expect(runHarnessTask(host, { runId: 'second', prompt: 'Retry' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_EFFECT_UNCERTAIN');
  expect(await inspectHarnessTaskBudget(host, contract.taskId)).toEqual(before);
}));

test('read-only interruption allows a fresh explicitly budgeted turn, never automatic replay', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Read' }, { taskAcceptance: contract, taskBudgetExisting: true });
  await host.store.saveToolCall!({ runId: 'first', scope: host.config.scope, toolCallId: 'read', toolName: 'read_file', revision: 1, idempotencyKey: 'read', status: 'running', updatedAt: 20 });
  const result = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(result.reasons).toEqual([]);
  expect(result.runs[0]?.effects[0]?.retry).toBe('fresh_read_within_budget');
  await runHarnessTask(host, { runId: 'second', prompt: 'Read again' }, { taskAcceptance: contract, taskBudgetExisting: true });
  expect((await inspectHarnessTaskBudget(host, contract.taskId)).confirmed.totalTokens).toBe(30);
}));

const checked: StreamEvent[][] = [[{ type: 'tool-call', toolCall: { id: 'check', name: 'run_check', input: { check: 'test', expectedScript: 'node --version' } } }, { type: 'finish', finishReason: 'tool-calls', usage }], done];
const executeChecked = (host: Awaited<ReturnType<typeof createHarness>>) => runHarnessTask(host, { runId: 'checked', prompt: 'Check result' }, { taskAcceptance: contract, taskBudgetExisting: true,
  resolveApprovals: async approvals => approvals.map(item => ({ provider: item.provider, approvalRequestId: item.id, approve: true })) });

test('inherited transcript uses original receipts without masking a missing receipt from a new execution', () => fixture(async host => {
  await executeChecked(host);
  const first = (await host.store.load('checked', host.config.scope))!;
  await runHarnessTask(host, { runId: 'second', messages: [...first.messages, createTextMessage('user', 'Continue')] }, { taskAcceptance: contract, taskBudgetExisting: true });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).reasons).not.toContain('TASK_CONTINUITY_EFFECT_EVIDENCE_MISSING');
  // A same-ID call generated again belongs to this run, never to the inherited transcript.
  const state = (await host.store.load('second', host.config.scope))!;
  const next = { ...state, revision: state.revision! + 1, steps: [{ ...state.steps[0]!, response: first.steps[0]!.response! }] };
  await host.store.save(next, { expectedRevision: state.revision! });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).reasons).toContain('TASK_CONTINUITY_EFFECT_EVIDENCE_MISSING');
}, [...checked, done]));

test('missing journal receipt blocks recovery even when final checkpoint and artifact remain', () => fixture(async host => {
  await executeChecked(host);
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).runs[0]?.checks).toEqual([{ id: 'test', status: 'confirmed' }]);
  const database = new SqliteDatabase(host.persistence!.databasePath!);
  try {
    const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
    const table = tables.find(row => row.name.endsWith('_tool_journal'))!.name;
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected fixture table');
    database.exec(`DELETE FROM ${table}`);
  } finally { database.close(); }
  const recovery = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(recovery.reasons).toContain('TASK_CONTINUITY_CHECK_EVIDENCE_MISSING');
  await expect(runHarnessTask(host, { runId: 'no-replay', prompt: 'Continue' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_');
}, checked));

test('fresh workspace drift invalidates checks without erasing contract or authorizing replay', () => fixture(async (host, root) => {
  await executeChecked(host);
  await writeFile(root + '/result.txt', 'changed');
  const recovery = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(recovery.currentContract?.revision).toBe(1);
  expect(recovery.runs[0]?.checks).toEqual([{ id: 'test', status: 'missing_or_stale' }]);
  expect(recovery.nextAction).toBe('explicit_budgeted_continuation');
}, checked));

test('missing required artifact blocks with an explicit reason rather than a fabricated result', () => fixture(async (host, root) => {
  await executeChecked(host);
  await rm(root + '/result.txt');
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).reasons).toContain('TASK_CONTINUITY_ARTIFACT_UNAVAILABLE');
  await expect(runHarnessTask(host, { runId: 'recreate', prompt: 'Continue' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_ARTIFACT_UNAVAILABLE');
}, checked));

test('human requirement revision preserves independent checks; changed check invalidates only its dependency', () => fixture(async host => {
  await executeChecked(host);
  let state = (await host.store.load('checked', host.config.scope))!;
  const revised = { ...contract, humanReview: [{ id: 'human', requirement: 'New review text', status: 'pending' as const }] };
  await reviseHarnessTaskAcceptance(host, { runId: 'checked', expectedRunRevision: state.revision!, expectedContractRevision: 1, contract: revised });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).runs[0]?.checks).toEqual([{ id: 'test', status: 'confirmed' }]);
  state = (await host.store.load('checked', host.config.scope))!;
  await reviseHarnessTaskAcceptance(host, { runId: 'checked', expectedRunRevision: state.revision!, expectedContractRevision: 2,
    contract: { ...revised, requiredChecks: revised.requiredChecks.map(check => ({ ...check, purpose: 'Changed check requirement' })) } });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).runs[0]?.checks[0]?.status).not.toBe('confirmed');
}, checked));

test('draft with missing account refuses read and never initializes a replacement account', () => fixture(async host => {
  await persistHarnessTaskDraft(host, 'session', { schemaVersion: 1, goal: 'Goal', contract });
  const proxy = new Proxy(host.store, { get(target, key) { if (key === 'load') return (id: string, scope: any) => id.startsWith('task_budget_') ? undefined : target.load(id, scope); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await expect(readHarnessTaskDraft(proxy, host.config.scope, 'session')).rejects.toThrow('TASK_BUDGET_MISSING');
}));

test('partial logical backup refuses continuation because monetary authority is absent', () => fixture(async (host, root) => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Goal' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const backup = await createHarnessStateBackup(host.config);
  await importHarnessStateBackup({ ...host.config, stateDirectory: root + '/import' }, backup);
  const imported = await createHarness({ workspace: root, stateDirectory: root + '/import', usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  try { await expect(inspectHarnessTaskContinuity(imported, contract.taskId)).rejects.toThrow('USAGE_LEDGER_MISSING'); }
  finally { await imported.close(); }
}));

test('digest corruption in retained objective blocks continuation without returning it as confirmed', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Goal' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('first', host.config.scope))!;
  const sources = state.metadata!.zhivexTaskSources as any[];
  sources[0].text = 'Corrupt objective';
  await host.store.save(state, { expectedRevision: state.revision! });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).reasons).toContain('TASK_CONTINUITY_SOURCE_INVALID');
  await expect(runHarnessTask(host, { runId: 'next', prompt: 'Continue' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_SOURCE_INVALID');
}));

test('disk-full final persistence never invents delivery success or repeats a recorded effect', () => fixture(async host => {
  const originalStore = host.store;
  let failures = 0;
  host.store = new Proxy(originalStore, { get(target, key) {
    if (key === 'save') return async (state: any, options: any) => {
    if (state.runId === 'checked' && ['completed', 'failed'].includes(state.status)) {
      failures++;
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    }
    return target.save(state, options);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try { await expect(executeChecked(host)).rejects.toThrow('fixture disk full'); } finally { host.store = originalStore; }
  expect(failures).toBeGreaterThan(0);
  const recovery = await inspectHarnessTaskContinuity(host, contract.taskId);
  expect(recovery.runs[0]?.status).not.toBe('completed');
  expect(recovery.reasons).toContain('TASK_CONTINUITY_FINALIZATION_UNCONFIRMED');
  expect(recovery.runs[0]?.effects.some(effect => effect.tool === 'run_check' && effect.status === 'recorded')).toBe(true);
  const before = await inspectHarnessTaskBudget(host, contract.taskId);
  await expect(runHarnessTask(host, { runId: 'retry', prompt: 'Continue' }, { taskAcceptance: contract, taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_FINALIZATION_UNCONFIRMED');
  expect(await inspectHarnessTaskBudget(host, contract.taskId)).toEqual(before);
}, checked));

test('complete stopped-host database copy preserves continuity; retention cannot erase linked task evidence', () => fixture(async (host, root) => {
  await executeChecked(host);
  const before = await inspectHarnessTaskContinuity(host, contract.taskId);
  await expect(Promise.resolve().then(() => host.store.delete!('checked', host.config.scope))).rejects.toThrow('TASK_BUDGET_RETENTION_REQUIRED');
  await host.close();
  await cp(host.config.stateDirectory, root + '/full-copy', { recursive: true });
  const restored = await createHarness({ workspace: root, stateDirectory: root + '/full-copy', usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  try { expect(await inspectHarnessTaskContinuity(restored, contract.taskId)).toEqual(before); }
  finally { await restored.close(); }
}, checked));

test('actual semantic compaction retains operator sources and marks recovered assistant prose unverified', () => fixture(async (old, root) => {
  await old.close();
  const host = await createHarness({ workspace: root, subagentProfiles: [], usageAccounting: {}, modelInstance: createMockLanguageModel({ streamEvents: [done] }),
    compactionMaxMessages: 4, compactionKeepRecentMessages: 2, compactionModel: 'mock-utility',
    compactionModelInstance: createMockLanguageModel({ responses: [{ text: 'Compact retained context', finishReason: 'stop', usage }] }) });
  try {
    await runHarnessTask(host, { runId: 'compact', messages: [createTextMessage('user', 'Preserve the exact objective. '.repeat(1500)),
      createTextMessage('assistant', 'Prior unverified report. '.repeat(200)), createTextMessage('user', 'Keep constraints'), createTextMessage('assistant', 'Not an authorization'), createTextMessage('user', 'Continue')] },
    { taskAcceptance: contract, taskBudgetExisting: true });
    const recovery = await inspectHarnessTaskContinuity(host, contract.taskId);
    expect(recovery.runs[0]?.sources.some(source => source.text.includes('Preserve the exact objective.'))).toBe(true);
    expect(recovery.runs[0]?.assistantResponses.every(response => response.untrusted && !response.verified)).toBe(true);
    expect(recovery.budget.monetaryDetails.categories).toContain('compaction');
  } finally { await host.close(); }
}));

test('account revision is rechecked under the invocation lease before claiming or dispatching', () => fixture(async host => {
  const account = await openHarnessTaskBudget(host, contract.taskId);
  const revision = (await account.summary()).revision;
  await account.run('intervening', async () => {});
  let dispatched = false;
  await expect(account.run('stale', async () => { dispatched = true; }, { expectedAccountRevision: revision })).rejects.toThrow('TASK_CONTINUITY_CHANGED');
  expect(dispatched).toBe(false);
  expect((await account.summary()).runs).toEqual(['intervening']);
}));

test('a supplied checkpoint cannot strip the durable budget binding to bypass recovery', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Goal' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('first', host.config.scope))!;
  delete state.metadata![TASK_BUDGET_KEY];
  await expect(runHarnessTask(host, { state }, { taskBudgetExisting: true })).rejects.toThrow('TASK_CONTINUITY_BINDING_CONFLICT');
}));

test('old approval cannot resume after a later run establishes the current authority', () => fixture(async host => {
  const waiting = await runHarnessTask(host, { runId: 'old', prompt: 'Check' }, { taskAcceptance: contract, taskBudgetExisting: true });
  expect(waiting.status).toBe('waiting_approval');
  await runHarnessTask(host, { runId: 'new', prompt: 'Continue separately' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('old', host.config.scope))!;
  await expect(runHarnessTask(host, { state, approvals: state.pendingApprovals.map(item => ({ provider: item.provider, approvalRequestId: item.id, approve: true })) }, { taskBudgetExisting: true }))
    .rejects.toThrow('TASK_CONTINUITY_STALE_RUN');
  await expect(reviseHarnessTaskAcceptance(host, { runId: 'old', expectedRunRevision: state.revision!, expectedContractRevision: 1, contract: { ...contract, humanReview: [] } })).rejects.toThrow('TASK_CONTINUITY_STALE_RUN');
}, checked));

test('malformed retained source cannot silently disappear behind another valid source', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Goal' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('first', host.config.scope))!;
  (state.metadata!.zhivexTaskSources as any[]).push({ id: 'invalid', text: 'Missing original constraint' });
  await host.store.save(state, { expectedRevision: state.revision! });
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).reasons).toContain('TASK_CONTINUITY_SOURCE_INVALID');
}));

test('contract revision retains the task lease until its paused durable write completes', () => fixture(async host => {
  await runHarnessTask(host, { runId: 'first', prompt: 'Goal' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const state = (await host.store.load('first', host.config.scope))!;
  const originalStore = host.store;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  host.store = new Proxy(originalStore, { get(target, key) {
    if (key === 'save') return async (value: any, options: any) => {
      if (value.runId === 'first' && value.metadata?.[TASK_ACCEPTANCE_KEY]?.revisions.length === 2) { entered(); await proceed; }
      return target.save(value, options);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = reviseHarnessTaskAcceptance(host, { runId: 'first', expectedRunRevision: state.revision!, expectedContractRevision: 1,
    contract: { ...contract, humanReview: [] } });
  try {
    await ready;
    const account = await openHarnessTaskBudget(host, contract.taskId);
    await expect(account.run('competing', async () => { throw new Error('must not execute'); })).rejects.toThrow('TASK_BUDGET_ACTIVE');
  } finally { release(); await pending; host.store = originalStore; }
  expect((await inspectHarnessTaskContinuity(host, contract.taskId)).currentContract?.revision).toBe(2);
}));

for (const stage of ['before-receipt', 'after-receipt']) test(`SIGKILL ${stage} preserves the real effect and blocks replay on the next host`, () => fixture(async (old, root) => {
  await old.close();
  const command = 'node -e "require(\'fs\').appendFileSync(\'result.txt\', \'effect\\n\')"';
  await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: command } }));
  const workerContract = { ...contract, requiredChecks: contract.requiredChecks.map(check => ({ ...check, expectedScript: command })) };
  const worker = root + '/worker.ts';
  await writeFile(worker, `
import { createHarness, runHarnessTask } from ${JSON.stringify(new URL('../src/runtime/harness.ts', import.meta.url).pathname)};
import { createMockLanguageModel } from ${JSON.stringify(new URL('../node_modules/@zhivex-ai/agents/dist/testing.js', import.meta.url).pathname)};
const contract = ${JSON.stringify(workerContract)};
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const host = await createHarness({ workspace: ${JSON.stringify(root)}, subagentProfiles: [], usageAccounting: {}, modelInstance: createMockLanguageModel({ streamEvents: [[
  { type: 'tool-call', toolCall: { id: 'effect', name: 'run_check', input: { check: 'test', expectedScript: ${JSON.stringify(command)} } } },
  { type: 'finish', finishReason: 'tool-calls', usage }
]] }) });
host.store = new Proxy(host.store, { get(target, key) {
  if (key === 'completeToolExecution') return async (entry, options) => {
    if (entry.toolName === 'run_check') {
      if (${JSON.stringify(stage)} === 'after-receipt') await target.completeToolExecution(entry, options);
      process.send({ ready: true }); await new Promise(() => {});
    }
    return target.completeToolExecution(entry, options);
  };
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} });
await runHarnessTask(host, { runId: 'crashed', prompt: 'One approved effect' }, { taskAcceptance: contract, taskBudgetExisting: true,
  resolveApprovals: async approvals => approvals.map(item => ({ provider: item.provider, approvalRequestId: item.id, approve: true })) });
`);
  const child = spawn(process.execPath, [worker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, CI: '1' } });
  let error = ''; child.stderr!.on('data', chunk => { error += chunk; });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('exit', () => reject(new Error(error || 'Worker exited before cut'))); });
    expect(await readFile(root + '/result.txt', 'utf8')).toBe('originaleffect\n');
  } finally { child.kill('SIGKILL'); await exited; }
  const host = await createHarness({ workspace: root, subagentProfiles: [], usageAccounting: {}, modelInstance: createMockLanguageModel() });
  try {
    const recovery = await inspectHarnessTaskContinuity(host, contract.taskId);
    expect(recovery.reasons).toContain('TASK_BUDGET_INVOCATION_UNCERTAIN');
    expect(recovery.runs[0]?.effects.find(effect => effect.tool === 'run_check')?.status).toBe(stage === 'after-receipt' ? 'recorded' : 'unknown');
    await expect(runHarnessTask(host, { runId: 'replay', prompt: 'Continue' }, { taskAcceptance: workerContract, taskBudgetExisting: true })).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
    expect(await readFile(root + '/result.txt', 'utf8')).toBe('originaleffect\n');
  } finally { await host.close(); }
}), 15000);
