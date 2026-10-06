import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, runHarnessTask as runHarness } from '../src/runtime/harness.js';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget, persistHarnessTaskDraft, readHarnessTaskDraft } from '../src/runtime/task-budget-host.js';
import { createHarnessStateBackup, importHarnessStateBackup } from '../src/persistence/state-backup.js';
import { TASK_BUDGET_KEY } from '../src/runtime/task-budget.js';
import { USAGE_LEDGER_KEY } from '../src/runtime/usage-ledger.js';
import type { TaskAcceptanceContract } from '../src/runtime/task-acceptance.js';
import { SqliteDatabase } from '../src/persistence/sqlite-database.js';

const requirements: TaskAcceptanceContract = { schemaVersion: 1, taskId: 'host-task', allowedWritePaths: ['result.mjs'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'Fixture test', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'review', requirement: 'Review result', status: 'pending' }] };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const model = () => createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop', usage }]] });
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp('/tmp/harness-task-owner-');
  try {
    await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
    await writeFile(root + '/result.mjs', 'export const value = 1;\n');
    await work(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('host task authority charges distinct runs, freezes policy across reopen and fences missing monetary imports', async () => fixture(async root => {
  let host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
  try {
    await initializeHarnessTaskBudget(host, requirements.taskId);
    const first = await runHarness(host, { runId: 'first', prompt: 'Inspect', maxRetries: 2 }, { taskAcceptance: requirements, taskBudgetExisting: true });
    expect(first.state.metadata?.[USAGE_LEDGER_KEY]).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 });
    const original = await inspectHarnessTaskBudget(host, requirements.taskId);
    await host.close();
    host = await createHarness({ workspace: root, usageAccounting: { limitUsd: 100 }, maxOutputTokens: 100000, subagentProfiles: [], modelInstance: model() });
    await runHarness(host, { runId: 'second', prompt: 'Correct' }, { taskAcceptance: requirements, taskBudgetExisting: true, taskBudgetContinue: true });
    const current = await inspectHarnessTaskBudget(host, requirements.taskId);
    expect(current.limits).toEqual(original.limits);
    expect(current.confirmed.totalTokens).toBe(30);
    expect(current.monetary).toMatchObject({ calls: 2, limitUsd: null });
    const durable = (await host.store.load('second', host.config.scope))!;
    // Same-run approvals/resume address the common monetary owner, never second.
    expect(durable.metadata?.[TASK_BUDGET_KEY]).toMatchObject({ accountRunId: original.accountRunId });
    const backup = await createHarnessStateBackup(host.config);
    const targetConfig = { ...host.config, stateDirectory: root + '/logical-import' };
    await importHarnessStateBackup(targetConfig, backup);
    const target = await createHarness({ workspace: root, stateDirectory: targetConfig.stateDirectory, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
    try {
      await expect(inspectHarnessTaskBudget(target, requirements.taskId)).rejects.toThrow('USAGE_LEDGER_MISSING');
      await expect(runHarness(target, { runId: 'third', prompt: 'Continue' }, { taskAcceptance: requirements, taskBudgetExisting: true })).rejects.toThrow('USAGE_LEDGER_MISSING');
      expect(await target.store.load('third', target.config.scope)).toBeUndefined();
    } finally { await target.close(); }
  } finally { await host.close(); }
}));

test('draft survives refusal before the first run without fabricating a model checkpoint', async () => fixture(async root => {
  let host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
  const brief = { schemaVersion: 1, budgetVersion: 1, goal: 'Inspect', constraints: [], contract: requirements, baseline: {} };
  try {
    await initializeHarnessTaskBudget(host, requirements.taskId);
    await persistHarnessTaskDraft(host, 'session-fixture', brief);
    expect(await host.store.load('unadmitted', host.config.scope)).toBeUndefined();
    await host.close();
    host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
    expect(await readHarnessTaskDraft(host.store, host.config.scope, 'session-fixture')).toEqual(brief);
    expect((await inspectHarnessTaskBudget(host, requirements.taskId)).confirmed.totalTokens).toBe(0);
  } finally { await host.close(); }
}));

for (const existing of [false, true]) for (const takeover of [false, true])
test(`SQLite rejects a delayed draft ${existing ? 'update' : 'insert'} after lease ${takeover ? 'takeover' : 'expiry'}`, async () => fixture(async root => {
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
  const brief = { schemaVersion: 1, budgetVersion: 1, goal: 'Original', constraints: [], contract: requirements, baseline: {} };
  const original = host.store;
  const database = new SqliteDatabase(host.persistence!.databasePath!);
  let release!: () => void, paused!: () => void, draftRunId = '';
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { paused = resolve; });
  try {
    await initializeHarnessTaskBudget(host, requirements.taskId);
    if (existing) await persistHarnessTaskDraft(host, 'delayed-draft', brief);
    host.store = new Proxy(original, { get(target, key) {
      if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
        if (args[0].metadata?.zhivexTaskDraftV1) { draftRunId = args[0].runId; paused(); await gate; }
        return target.save(...args);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const writing = persistHarnessTaskDraft(host, 'delayed-draft', { ...brief, goal: 'Stale change' });
    await ready;
    if (takeover) {
      expect(await original.acquireLease!(draftRunId, { ownerId: 'new-draft-owner', ttlMs: 30_000, now: Date.now() + 60_000 }, host.config.scope)).toBeDefined();
    } else database.query('UPDATE zhivex_agent_runs_leases SET expires_at_ms = 0 WHERE run_id = ?').run(draftRunId);
    release();
    await expect(writing).rejects.toThrow('TASK_DRAFT_LEASE_LOST');
    expect(await readHarnessTaskDraft(original, host.config.scope, 'delayed-draft')).toEqual(existing ? brief : undefined);
    if (existing) expect((await original.load(draftRunId, host.config.scope))!.revision).toBe(1);
    // Ordinary SDK checkpoint writes retain their original behavior, without
    // claiming that core 1.30.1 save fences leaseOwnerId generically.
    const rootState = (await original.load((await inspectHarnessTaskBudget(host, requirements.taskId)).accountRunId, host.config.scope))!;
    const { budgetCoordinatorId: ignoredCoordinator, ...ordinary } = rootState;
    void ignoredCoordinator;
    await original.save({ ...ordinary, runId: 'ordinary-control-test', metadata: {} }, { expectedRevision: 0, leaseOwnerId: 'unowned-ordinary' });
    expect(await original.load('ordinary-control-test', host.config.scope)).toBeDefined();
  } finally { release(); host.store = original; database.close(); await host.close(); }
}));

test('draft logical import owns only a transient lease and rollback leaves no lease', async () => fixture(async root => {
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
  const brief = { schemaVersion: 1, budgetVersion: 1, goal: 'Retained draft', constraints: [], contract: requirements, baseline: {} };
  try {
    await initializeHarnessTaskBudget(host, requirements.taskId);
    await persistHarnessTaskDraft(host, 'backup-draft', brief);
    const bundle = await createHarnessStateBackup(host.config);
    const config = { ...host.config, stateDirectory: root + '/draft-import' };
    await expect(importHarnessStateBackup(config, bundle, { failAfterWrites: 1 })).rejects.toThrow('Injected state import failure');
    const target = await createHarness({ workspace: root, stateDirectory: config.stateDirectory, usageAccounting: {}, subagentProfiles: [], modelInstance: model() });
    const database = new SqliteDatabase(target.persistence!.databasePath!);
    try {
      expect(database.query<{ count: number }>('SELECT COUNT(*) AS count FROM zhivex_agent_runs_leases').get()!.count).toBe(0);
      await importHarnessStateBackup(config, bundle);
      expect(await readHarnessTaskDraft(target.store, target.config.scope, 'backup-draft')).toEqual(brief);
      expect(database.query<{ count: number }>('SELECT COUNT(*) AS count FROM zhivex_agent_runs_leases').get()!.count).toBe(0);
      await expect(inspectHarnessTaskBudget(target, requirements.taskId)).rejects.toThrow('USAGE_LEDGER_MISSING');
    } finally { database.close(); await target.close(); }
  } finally { await host.close(); }
}));

for (const provider of ['meta', 'anthropic', 'qwen']) test(`guided task rejects an unvetted ${provider} transport before any request`, async () => fixture(async root => {
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel({ provider }) });
  try { await expect(initializeHarnessTaskBudget(host, requirements.taskId)).rejects.toThrow('TASK_BUDGET_'); }
  finally { await host.close(); }
}));
