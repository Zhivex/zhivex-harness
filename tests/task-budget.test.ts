import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore, createSqliteAgentRunStore } from '@zhivex-ai/agents/ops';
import { wrapLanguageModel, fingerprintAgentHarness, type AgentRunState, type LanguageModel, type ModelGenerateInput } from '@zhivex-ai/core';
import { ProviderToolCallError } from '@zhivex-ai/core/provider';
import { openHarnessPersistence, sqliteAdapter, type HarnessPersistence } from '../src/persistence/operations.js';
import { SqliteDatabase } from '../src/persistence/sqlite-database.js';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { createHarnessStateBackup, importHarnessStateBackup } from '../src/persistence/state-backup.js';
import { TASK_BUDGET_KEY, TASK_BUDGET_ACCOUNT_KEY, TaskBudget, inspectTaskBudgetSummary, assertTaskBudgetBackupLinks } from '../src/runtime/task-budget.js';

const scope = { tenantId: 'task-budget-tests', userId: 'operator', namespace: 'workspace' };
const policy = { limits: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 }, closureReserve: 0 };
const roots: string[] = [], stores: HarnessPersistence[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = (): ModelGenerateInput => ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], maxTokens: 20, maxRetries: 2 });
const model = (usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }): LanguageModel => createMockLanguageModel({
  provider: 'openai', modelId: 'fixture', responses: [{ text: 'done', messages: [], finishReason: 'stop', usage }] });
const runState = (runId: string): AgentRunState => ({ schemaVersion: 1, runId, scope, revision: 1, provider: 'openai', modelId: 'fixture',
  status: 'completed', messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0, maxSteps: 1, outputText: '', updatedAt: Date.now() });
async function fixture(taskId = 'task') {
  const store = createInMemoryAgentRunStore();
  const account = await TaskBudget.open({ store, scope, taskId, policy });
  return { store, account };
}

test('new turns and revisions share frozen task policy and immutable run bindings', async () => {
  const { store, account } = await fixture();
  await account.run('first', async () => {
    await wrapLanguageModel(model(), [account.middleware()]).generate(request());
    await account.checkpointStore(store).save(runState('first'), { expectedRevision: 0 });
  });
  const reopened = await TaskBudget.open({ store, scope, taskId: 'task', policy: { ...policy, limits: { inputTokens: 9999, outputTokens: 9999, totalTokens: 99999 } }, requireExisting: true });
  await reopened.run('revision', async () => {
    await wrapLanguageModel(model(), [reopened.middleware()]).generate(request());
    await reopened.checkpointStore(store).save(runState('revision'), { expectedRevision: 0 });
  });
  expect(await reopened.summary()).toMatchObject({ limits: policy.limits, confirmed: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, runs: ['first', 'revision'], usageComplete: true });
  expect(inspectTaskBudgetSummary((await store.load('revision', scope))?.metadata?.[TASK_BUDGET_KEY])?.taskId).toBe('task');
  const other = await TaskBudget.open({ store, scope, taskId: 'other', policy });
  await expect(other.run('first', async () => {})).rejects.toThrow('TASK_BUDGET_RUN_BINDING_MISSING');
});

test('task transport disables hidden retries, caps output, and includes auxiliary calls', async () => {
  const { account } = await fixture();
  const input = request();
  let observed: ModelGenerateInput | undefined;
  const main = model(); const original = main.generate;
  main.generate = value => { observed = value; return original(value); };
  await account.run('calls', async () => {
    await wrapLanguageModel(main, [account.middleware()]).generate(input);
    await wrapLanguageModel(model(), [account.middleware({ auxiliary: true })]).generate(request());
  });
  expect(observed?.maxRetries).toBe(0);
  expect(observed?.maxProviderRequests).toBe(1);
  expect(observed?.maxTokens).toBe(20);
  expect((await account.summary()).confirmed.totalTokens).toBe(30);
});

test('exhausted task and unsupported Qwen route stop before dispatch', async () => {
  const { store } = await fixture();
  const account = await TaskBudget.open({ store, scope, taskId: 'small', policy: { limits: { inputTokens: 2000, outputTokens: 5, totalTokens: 2005 }, closureReserve: 0 } });
  let calls = 0; const counted = model(); const generate = counted.generate;
  counted.generate = input => { calls++; return generate(input); };
  await account.run('one', () => wrapLanguageModel(counted, [account.middleware()]).generate(request()));
  await expect(account.run('two', () => wrapLanguageModel(counted, [account.middleware()]).generate(request()))).rejects.toThrow('TASK_BUDGET_EXHAUSTED');
  expect(calls).toBe(1);
  const qwen = { ...model(), provider: 'qwen' };
  await expect(TaskBudget.open({ store, scope, taskId: 'qwen', policy }).then(budget => budget.run('qwen-run', () =>
    wrapLanguageModel(qwen, [budget.middleware()]).generate(request())))).rejects.toThrow('TASK_BUDGET_OUTPUT_CAP_UNAVAILABLE');
});

test('uncertain usage retains exposure across new runs and prevents reopening', async () => {
  const { account, store } = await fixture();
  const failing = model(); failing.generate = async () => { throw new Error('connection lost'); };
  await expect(account.run('lost', () => wrapLanguageModel(failing, [account.middleware()]).generate(request()))).rejects.toThrow('TASK_BUDGET_UNCERTAIN');
  const summary = await account.summary();
  expect(summary).toMatchObject({ confirmed: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, unknown: { inputTokens: 2000, outputTokens: 20, totalTokens: 2100 }, usageComplete: false });
  const reopened = await TaskBudget.open({ store, scope, taskId: 'task', policy, requireExisting: true });
  await expect(reopened.run('retry', async () => {})).rejects.toThrow('TASK_BUDGET_UNCERTAIN');
  await expect(reopened.reopen(summary.revision)).rejects.toThrow('TASK_BUDGET_UNCERTAIN');
});

test('interrupted streams without a finish receipt hold the full reservation', async () => {
  const { account } = await fixture();
  const streaming = model();
  streaming.stream = async () => (async function* () { yield { type: 'text-delta' as const, textDelta: 'partial' }; })();
  await expect(account.run('stream', async () => {
    for await (const _event of await wrapLanguageModel(streaming, [account.middleware()]).stream!(request())) { /* drain */ }
  })).rejects.toThrow('Shared budget usage is unknown');
  expect((await account.summary()).unknown.outputTokens).toBe(20);
});

test('task lease excludes competing runs and late cancellation blocks new admissions', async () => {
  const { account, store } = await fixture();
  const competitor = await TaskBudget.open({ store, scope, taskId: 'task', policy, requireExisting: true });
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const abort = new AbortController();
  const running = account.run('slow', async () => {
    entered(); await gate;
    return wrapLanguageModel(model(), [account.middleware()]).generate(request());
  }, { signal: abort.signal });
  await ready;
  await expect(competitor.run('competitor', async () => {})).rejects.toThrow('TASK_BUDGET_ACTIVE');
  abort.abort(); release();
  await expect(running).rejects.toThrow();
  const closed = await account.summary();
  expect(closed.admissionsClosed).toBe(true);
  await expect(account.run('late-approval', async () => {})).rejects.toThrow('TASK_BUDGET_CANCELLED');
  await expect(account.reopen(closed.revision - 1)).rejects.toThrow('TASK_BUDGET_REVISION_CONFLICT');
  await account.reopen(closed.revision);
  await account.run('explicit-new-turn', () => wrapLanguageModel(model(), [account.middleware()]).generate(request()));
  expect((await account.summary()).confirmed.totalTokens).toBe(15);
});

test('existing account inspection is read-only while its transport and task lease are active', async () => {
  const { account, store } = await fixture();
  let release!: () => void, entered!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hanging = model(); const generate = hanging.generate;
  hanging.generate = async input => { entered(); await gate; return generate(input); };
  const running = account.run('active-transport', () => wrapLanguageModel(hanging, [account.middleware()]).generate(request()));
  await ready;
  const readonlyStore = new Proxy(store, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (['save', 'acquireLease', 'renewLease', 'releaseLease'].includes(String(key)) && typeof value === 'function') {
      return (...args: unknown[]) => { writes++; return value.apply(target, args); };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const before = await account.summary();
  const reader = await TaskBudget.open({ store: readonlyStore, scope, taskId: 'task', policy, requireExisting: true });
  expect(await reader.summary()).toEqual(before);
  expect(before).toMatchObject({ usageComplete: false, reserved: { inputTokens: 2000, outputTokens: 20, totalTokens: 2100 } });
  expect(writes).toBe(0);
  // Inspection grants no execution or permission to reopen an active task.
  await expect(reader.run('new-dispatch', async () => {})).rejects.toThrow('TASK_BUDGET_ACTIVE');
  await expect(reader.reopen(before.revision)).rejects.toThrow('TASK_BUDGET_ACTIVE');
  release(); await running;
  expect((await reader.summary()).confirmed.totalTokens).toBe(15);
});

test('a late complete receipt remains charged after cancellation and can explicitly reopen', async () => {
  const { account } = await fixture();
  const abort = new AbortController();
  const late = model(); const generate = late.generate;
  late.generate = async input => { abort.abort(); return generate(input); };
  await expect(account.run('late-receipt', () => wrapLanguageModel(late, [account.middleware()]).generate(request()), { signal: abort.signal })).rejects.toThrow();
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, usageComplete: true, confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  await account.reopen((await account.summary()).revision);
  expect((await account.summary()).admissionsClosed).toBe(false);
});

test('full remaining input is reserved rather than treating token prediction as a billing bound', async () => {
  const { account } = await fixture();
  await account.run('actual-input', () => wrapLanguageModel(model({ inputTokens: 1000, outputTokens: 5, totalTokens: 1005 }), [account.middleware()]).generate(request()));
  expect((await account.summary()).confirmed.inputTokens).toBe(1000);
});

for (const mode of ['generate', 'stream-open', 'stream-body'] as const) test(`typed rejected-response terminal receipt remains charged: ${mode}`, async () => {
  const { account } = await fixture(mode);
  const error = new ProviderToolCallError({ provider: 'openai', reason: 'incomplete_arguments', diagnosticCode: 'FIXTURE',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, usageComplete: true, providerRequestCount: 1 });
  const failing = model();
  failing.generate = async () => { throw error; };
  failing.stream = async () => {
    if (mode === 'stream-open') throw error;
    return (async function* () { throw error; })();
  };
  await expect(account.run(mode, async () => {
    const wrapped = wrapLanguageModel(failing, [account.middleware()]);
    if (mode === 'generate') return wrapped.generate(request());
    for await (const _event of await wrapped.stream!(request())) { /* drain */ }
  })).rejects.toBe(error);
  expect(await account.summary()).toMatchObject({ usageComplete: true, confirmed: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
});

test('lease expiry while a transport is outstanding retains admission exposure for the new owner', async () => {
  const store = createInMemoryAgentRunStore(); let time = Date.now();
  const account = await TaskBudget.open({ store, scope, taskId: 'expired', policy, now: () => time });
  let released!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const hanging = model(); const generate = hanging.generate;
  hanging.generate = async input => { started(); await gate; return generate(input); };
  const running = account.run('outstanding', () => wrapLanguageModel(hanging, [account.middleware()]).generate(request()));
  await ready; time += 31_000;
  const recovered = await TaskBudget.open({ store, scope, taskId: 'expired', policy, requireExisting: true, now: () => time });
  await expect(recovered.run('after-crash', async () => {})).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  expect((await recovered.summary()).reserved.totalTokens).toBe(2100);
  // Authoritative late receipt settles the same allocation, never a replacement call.
  released(); await expect(running).rejects.toThrow('TASK_BUDGET_LEASE_LOST');
  expect((await recovered.summary()).confirmed.totalTokens).toBe(15);
});

test('legacy and partial snapshots cannot create a fresh task account or ledger', async () => {
  const store = createInMemoryAgentRunStore();
  await expect(TaskBudget.open({ store, scope, taskId: 'legacy', policy, requireExisting: true })).rejects.toThrow('TASK_BUDGET_MISSING');
  const account = await TaskBudget.open({ store, scope, taskId: 'snapshot', policy });
  const budgetId = account.accountRunId;
  const budgetRunId = `budget_${fingerprintAgentHarness({ budgetId, scope }).slice('sha256:'.length)}`;
  await store.delete!(budgetRunId, { tenantId: scope.tenantId, userId: scope.userId, namespace: '__zhivex_budget__' });
  await expect(TaskBudget.open({ store, scope, taskId: 'snapshot', policy, requireExisting: true })).rejects.toThrow('TASK_BUDGET_LEDGER_MISSING');
});

test('backup rejects a missing task control root or altered frozen policy', async () => {
  const { account, store } = await fixture();
  await account.run('linked', async () => { await account.checkpointStore(store).save(runState('linked'), { expectedRevision: 0 }); });
  const root = (await store.load(account.accountRunId, scope))!;
  const linked = (await store.load('linked', scope))!;
  expect(() => assertTaskBudgetBackupLinks([root, linked])).not.toThrow();
  expect(() => assertTaskBudgetBackupLinks([linked])).toThrow('TASK_BUDGET_BACKUP_CONTROL_MISSING');
  const altered = structuredClone(root);
  const control = altered.metadata![TASK_BUDGET_ACCOUNT_KEY] as any;
  control.policy.limits.inputTokens++;
  expect(() => assertTaskBudgetBackupLinks([altered, linked])).toThrow('TASK_BUDGET_BACKUP_IDENTITY_MISMATCH');
});

test('ordinary task closure can spend its margin while refusing new tool work', async () => {
  const store = createInMemoryAgentRunStore();
  const account = await TaskBudget.open({ store, scope, taskId: 'closure', policy: { ...policy, closureReserve: 0.3 } });
  await account.run('work', () => wrapLanguageModel(model({ inputTokens: 10, outputTokens: 70, totalTokens: 80 }), [account.middleware()]).generate({ ...request(), maxTokens: 70 }));
  let observed: ModelGenerateInput | undefined; const closing = model(); const generate = closing.generate;
  closing.generate = input => { observed = input; return generate(input); };
  await account.run('closure', () => wrapLanguageModel(closing, [account.middleware({ closeOnBudget: true })]).generate({ ...request(),
    tools: { unsafe: { name: 'unsafe', description: 'must not execute', schema: z.object({}), execute: async () => 'must not execute' } } }));
  expect(observed?.tools).toBeUndefined();
  expect(JSON.stringify(observed?.messages)).toContain('cumulative work budget');
  const malicious = model(); malicious.generate = async () => ({ finishReason: 'tool-calls', messages: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  await expect(account.run('ignored-closure', () => wrapLanguageModel(malicious, [account.middleware({ closeOnBudget: true })]).generate(request()))).rejects.toThrow('TASK_BUDGET_CLOSURE_TOOLS_DENIED');
  expect((await account.summary()).confirmed.totalTokens).toBe(110);
});

for (const action of ['tool', 'checkpoint', 'return'] as const) test(`a stale task owner cannot perform ${action} after a confirmed model receipt`, async () => {
  const store = createInMemoryAgentRunStore(); let time = Date.now(); let effects = 0;
  const account = await TaskBudget.open({ store, scope, taskId: action, policy, now: () => time });
  await expect(account.run('old-owner', async () => {
    await wrapLanguageModel(model(), [account.middleware()]).generate(request());
    time += 31_000;
    await store.acquireLease!(account.accountRunId, { ownerId: 'new-owner', ttlMs: 30_000, now: time }, scope);
    if (action === 'tool') {
      const guarded = account.wrapTools({ unsafe: { name: 'unsafe', description: 'effect', schema: z.object({}), execute: async () => { effects++; return 'effect'; } } });
      if ('execute' in guarded.unsafe!) await guarded.unsafe.execute!({}, {} as any);
    } else if (action === 'checkpoint') await account.checkpointStore(store).save(runState('old-owner'), { expectedRevision: 0 });
    return 'stale success';
  })).rejects.toThrow('TASK_BUDGET_LEASE_LOST');
  expect(effects).toBe(0);
  expect(await store.load('old-owner', scope)).toBeUndefined();
  expect((await account.summary()).confirmed.totalTokens).toBe(15);
});

test('ownership lost after reservation but before transport releases only its proven undispatched allocation', async () => {
  const store = createInMemoryAgentRunStore(); let time = Date.now(), arm = false, calls = 0;
  let account!: TaskBudget;
  const wrappedStore = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof store.save>) => {
      await target.save(...args);
      if (arm && args[0].metadata?.budgetCoordinator) {
        arm = false; time += 31_000;
        await target.acquireLease!(account.accountRunId, { ownerId: 'new-owner', ttlMs: 30_000, now: time }, scope);
      }
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  account = await TaskBudget.open({ store: wrappedStore, scope, taskId: 'before-dispatch', policy, now: () => time });
  const counted = model(); const generate = counted.generate;
  counted.generate = input => { calls++; return generate(input); };
  arm = true;
  await expect(account.run('old-owner', () => wrapLanguageModel(counted, [account.middleware()]).generate(request()))).rejects.toThrow('TASK_BUDGET_LEASE_LOST');
  expect(calls).toBe(0);
  expect(await account.summary()).toMatchObject({ usageComplete: true, confirmed: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, remaining: policy.limits });
});

test('an ongoing tool prevents a second invocation after lease expiry despite confirmed model usage', async () => {
  const store = createInMemoryAgentRunStore(); let time = Date.now(), oldEffects = 0, newEffects = 0;
  const account = await TaskBudget.open({ store, scope, taskId: 'ongoing-effect', policy, now: () => time });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const guarded = account.wrapTools({ check: { name: 'check', description: 'long running native check', schema: z.object({}),
    execute: async () => { entered(); await gate; oldEffects++; return 'finished'; } } });
  const running = account.run('old-check', async () => {
    await wrapLanguageModel(model(), [account.middleware()]).generate(request());
    if ('execute' in guarded.check!) {
      const effect = guarded.check.execute!({}, {} as any); effect.catch(() => {});
    }
    await ready;
    return 'SDK stopped awaiting the check';
  });
  await ready; time += 31_000;
  const next = await TaskBudget.open({ store, scope, taskId: 'ongoing-effect', policy, requireExisting: true, now: () => time });
  expect(await next.summary()).toMatchObject({ usageComplete: true, confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, invocationPending: true, activeRunId: 'old-check' });
  await expect(next.run('new-check', async () => { newEffects++; })).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  expect(newEffects).toBe(0);
  release(); await expect(running).rejects.toThrow('TASK_BUDGET_LEASE_LOST');
  expect(oldEffects).toBe(1);
  expect((await next.summary()).invocationPending).toBe(true);
  await expect(next.reopen((await next.summary()).revision)).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
});

test('known cancellation drains outstanding native callbacks before clearing the invocation', async () => {
  const { account } = await fixture(); const abort = new AbortController();
  let release!: () => void, entered!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const guarded = account.wrapTools({ check: { name: 'check', description: 'bounded callback', schema: z.object({}),
    execute: async () => { entered(); await gate; return 'drained'; } } });
  const running = account.run('cancel-drain', async () => {
    if ('execute' in guarded.check!) {
      const effect = guarded.check.execute!({}, {} as any); effect.catch(() => {});
    }
    await ready; return 'cancelled by SDK';
  }, { signal: abort.signal });
  running.then(() => { settled = true; }, () => { settled = true; });
  await ready; abort.abort();
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  expect((await account.summary()).invocationPending).toBe(true);
  release(); await expect(running).rejects.toThrow();
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, invocationPending: false, activeRunId: null });
  await account.reopen((await account.summary()).revision);
});

test('SQLite restart and complete backup roundtrip preserve task policy, membership and spent tokens', async () => {
  async function database() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'task-budget-db-')); roots.push(root);
    const config = resolveHarnessConfig({ workspace: root, ...scope });
    const persistence = await openHarnessPersistence(config); stores.push(persistence);
    return { config, persistence };
  }
  const source = await database();
  const account = await TaskBudget.open({ store: source.persistence.store, scope: source.config.scope, taskId: 'persisted', policy });
  await account.run('persisted-run', async () => {
    await wrapLanguageModel(model(), [account.middleware()]).generate(request());
    await account.checkpointStore(source.persistence.store).save({ ...runState('persisted-run'), scope: source.config.scope }, { expectedRevision: 0 });
  });
  const backup = await createHarnessStateBackup(source.config);
  expect(backup.records.budgetLedgers?.length).toBe(1);
  source.persistence.close(); stores.splice(stores.indexOf(source.persistence), 1);
  const restarted = await openHarnessPersistence(source.config); stores.push(restarted);
  const restored = await TaskBudget.open({ store: restarted.store, scope: source.config.scope, taskId: 'persisted', policy, requireExisting: true });
  expect((await restored.summary()).confirmed.totalTokens).toBe(15);
  const targetConfig = resolveHarnessConfig({ workspace: source.config.workspace, stateDirectory: path.join(source.config.workspace, 'restored'), ...source.config.scope });
  await importHarnessStateBackup(targetConfig, backup);
  const targetPersistence = await openHarnessPersistence(targetConfig); stores.push(targetPersistence);
  const imported = await TaskBudget.open({ store: targetPersistence.store, scope: targetConfig.scope, taskId: 'persisted', policy, requireExisting: true });
  expect(await imported.summary()).toMatchObject({ confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, runs: ['persisted-run'], usageComplete: true });
});

test('a real worker exit before receipt keeps its SQLite reservation and blocks a later process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-budget-crash-')); roots.push(root);
  const modulePath = new URL('../src/runtime/task-budget.ts', import.meta.url).pathname;
  const operationsPath = new URL('../src/persistence/operations.ts', import.meta.url).pathname;
  const configPath = new URL('../src/runtime/config.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '--eval', `
    import { TaskBudget } from ${JSON.stringify(modulePath)};
    import { openHarnessPersistence } from ${JSON.stringify(operationsPath)};
    import { resolveHarnessConfig } from ${JSON.stringify(configPath)};
    import { wrapLanguageModel } from '@zhivex-ai/core';
    const config=resolveHarnessConfig({workspace:${JSON.stringify(root)},...${JSON.stringify(scope)}});
    const persistence=await openHarnessPersistence(config);
    const account=await TaskBudget.open({store:persistence.store,scope:config.scope,taskId:'crashed',policy:${JSON.stringify(policy)}});
    const model={provider:'openai',modelId:'fixture',generate:async()=>{process.stdout.write('reserved');process.exit(0);}};
    await account.run('crashed-run',()=>wrapLanguageModel(model,[account.middleware()]).generate(${JSON.stringify(request())}));
  `], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0); expect(stdout).toBe('reserved');
  const config = resolveHarnessConfig({ workspace: root, ...scope });
  const persistence = await openHarnessPersistence(config); stores.push(persistence);
  const recovered = await TaskBudget.open({ store: persistence.store, scope: config.scope, taskId: 'crashed', policy,
    requireExisting: true, now: () => Date.now() + 60_000 });
  expect(await recovered.summary()).toMatchObject({ usageComplete: false, reserved: { inputTokens: 2000, outputTokens: 20, totalTokens: 2100 }, remaining: { inputTokens: 0, outputTokens: 80, totalTokens: 0 } });
  await expect(recovered.run('fresh-id-cannot-reset', async () => {})).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  await expect(createHarnessStateBackup(config)).rejects.toThrow('TASK_BUDGET_BACKUP_INVOCATION_PENDING');
});

test('a real worker exit after confirmed model usage retains the active native invocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-budget-effect-crash-')); roots.push(root);
  const taskPath = new URL('../src/runtime/task-budget.ts', import.meta.url).pathname;
  const operationsPath = new URL('../src/persistence/operations.ts', import.meta.url).pathname;
  const configPath = new URL('../src/runtime/config.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '--eval', `
    import {TaskBudget} from ${JSON.stringify(taskPath)};
    import {openHarnessPersistence} from ${JSON.stringify(operationsPath)};
    import {resolveHarnessConfig} from ${JSON.stringify(configPath)};
    import {wrapLanguageModel} from '@zhivex-ai/core';
    import {z} from 'zod';
    const config=resolveHarnessConfig({workspace:${JSON.stringify(root)},...${JSON.stringify(scope)}});
    const persistence=await openHarnessPersistence(config);
    const account=await TaskBudget.open({store:persistence.store,scope:config.scope,taskId:'effect-crashed',policy:${JSON.stringify(policy)}});
    const model={provider:'openai',modelId:'fixture',generate:async()=>({messages:[],text:'done',finishReason:'stop',usage:{inputTokens:10,outputTokens:5,totalTokens:15}})};
    const tools=account.wrapTools({check:{name:'check',description:'native effect',schema:z.object({}),execute:async()=>{process.stdout.write('effect-started');process.exit(0);}}});
    await account.run('effect-run',async()=>{
      await wrapLanguageModel(model,[account.middleware()]).generate(${JSON.stringify(request())});
      await tools.check.execute({},{});
    });
  `], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0); expect(stdout).toBe('effect-started');
  const config = resolveHarnessConfig({ workspace: root, ...scope });
  const persistence = await openHarnessPersistence(config); stores.push(persistence);
  const recovered = await TaskBudget.open({ store: persistence.store, scope: config.scope, taskId: 'effect-crashed', policy,
    requireExisting: true, now: () => Date.now() + 60_000 });
  expect(await recovered.summary()).toMatchObject({ usageComplete: true, confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, invocationPending: true, activeRunId: 'effect-run' });
  await expect(recovered.run('different-id', async () => {})).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  await expect(recovered.reopen((await recovered.summary()).revision)).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  await expect(createHarnessStateBackup(config)).rejects.toThrow('TASK_BUDGET_BACKUP_INVOCATION_PENDING');
});

test('SQLite fences an expired worker paused between ownership check and invocation-clear save', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-budget-clear-fence-')); roots.push(root);
  const config = resolveHarnessConfig({ workspace: root, ...scope });
  const persistence = await openHarnessPersistence(config); stores.push(persistence);
  let release!: () => void, paused!: () => void, arm = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { paused = resolve; });
  const delayed = new Proxy(persistence.store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      const control = args[0].metadata?.[TASK_BUDGET_ACCOUNT_KEY] as any;
      if (arm && control && control.invocation === undefined) { arm = false; paused(); await gate; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const account = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'clear-fenced', policy });
  arm = true;
  const running = account.run('old-worker', () => wrapLanguageModel(model(), [account.middleware()]).generate(request()));
  await ready;
  await persistence.store.acquireLease!(account.accountRunId, { ownerId: 'new-owner', ttlMs: 30_000, now: Date.now() + 60_000 }, config.scope);
  release(); await expect(running).rejects.toThrow('TASK_BUDGET_LEASE_LOST');
  expect(await account.summary()).toMatchObject({ invocationPending: true, activeRunId: 'old-worker', usageComplete: true });
});

test('SQLite trigger protects task authority inserted after a stale retention read from raw SDK cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-budget-retention-')); roots.push(root);
  const config = resolveHarnessConfig({ workspace: root, ...scope });
  const persistence = await openHarnessPersistence(config); stores.push(persistence);
  const other = await openHarnessPersistence(config); stores.push(other);
  const before = Date.now() + 60_000;
  expect((await persistence.store.list!({ statuses: ['completed'], updatedBefore: before }, config.scope)).items).toHaveLength(0);
  const account = await TaskBudget.open({ store: other.store, scope: config.scope, taskId: 'new-after-read', policy });
  // Use the raw SDK path so protection cannot depend on a store wrapper preflight.
  await expect(Promise.resolve().then(() => persistence.store.deleteExpired!({ before, statuses: ['completed'] }, config.scope))).rejects.toThrow('TASK_BUDGET_RETENTION_REQUIRED');
  await expect(Promise.resolve().then(() => persistence.store.delete!(account.accountRunId, config.scope))).rejects.toThrow('TASK_BUDGET_RETENTION_REQUIRED');
  const budgetId = account.accountRunId;
  const budgetRunId = `budget_${fingerprintAgentHarness({ budgetId, scope: config.scope }).slice('sha256:'.length)}`;
  const database = new SqliteDatabase(persistence.databasePath!);
  try {
    const raw = createSqliteAgentRunStore({ db: sqliteAdapter(database) });
    await expect(Promise.resolve().then(() => raw.delete!(budgetRunId,
      { tenantId: config.scope.tenantId, userId: config.scope.userId!, namespace: '__zhivex_budget__' }))).rejects.toThrow('TASK_BUDGET_RETENTION_REQUIRED');
  } finally { database.close(); }
  expect((await account.summary()).usageComplete).toBe(true);
  // The trigger leaves cleanup of unrelated ordinary runs intact.
  await persistence.store.save({ ...runState('ordinary'), scope: config.scope }, { expectedRevision: 0 });
  await persistence.store.delete!('ordinary', config.scope);
  expect(await persistence.store.load('ordinary', config.scope)).toBeUndefined();
});
