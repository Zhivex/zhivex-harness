import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { cancelHarnessRun, openHarnessPersistence } from '../src/persistence/operations.js';
import { TaskBudget, TASK_BUDGET_ACCOUNT_KEY } from '../src/runtime/task-budget.js';
import type { AgentRunState } from '@zhivex-ai/core';

async function fixture(work: (p: Awaited<ReturnType<typeof openHarnessPersistence>>, config: ReturnType<typeof resolveHarnessConfig>) => Promise<void>) {
  const root = await mkdtemp('/tmp/task-cancellation-');
  const config = resolveHarnessConfig({ workspace: root, storeBackend: 'sqlite', subagentProfiles: [] });
  const persistence = await openHarnessPersistence(config);
  try { await work(persistence, config); }
  finally { persistence.close(); await rm(root, { recursive: true, force: true }); }
}
const state = (config: ReturnType<typeof resolveHarnessConfig>, status: AgentRunState['status']): AgentRunState => ({
  schemaVersion: 1, runId: 'terminal', scope: config.scope, revision: 1, provider: 'mock', modelId: 'fixture', status,
  messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0, maxSteps: 1,
  outputText: 'retained work', updatedAt: Date.now(), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  ...(status === 'failed' || status === 'timed_out' ? { error: { message: 'retained failure' } } : {})
});

for (const status of ['completed', 'failed', 'timed_out', 'cancelled'] as const)
test(`cancel preserves durable terminal ${status} and receipts`, () => fixture(async ({ store }, config) => {
  const before = state(config, status); await store.save(before, { expectedRevision: 0 });
  await cancelHarnessRun(store, config, before.runId);
  expect(await store.load(before.runId, config.scope)).toEqual(before);
}));

test('terminal completion during cancellation save wins without loss of receipts', () => fixture(async ({ store }, config) => {
  const before = state(config, 'running'); await store.save(before, { expectedRevision: 0 });
  const lease = await store.acquireLease!(before.runId, { ownerId: 'real-worker', ttlMs: 30000 }, config.scope);
  expect(lease).toBeDefined();
  let paused!: () => void, release!: () => void, intercepted = false;
  const ready = new Promise<void>(resolve => { paused = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      if (!intercepted && args[0].status === 'cancel_requested') { intercepted = true; paused(); await gate; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const cancelling = cancelHarnessRun(delayed, config, before.runId);
  await ready;
  const completed = { ...before, revision: 2, status: 'completed' as const };
  await store.save(completed, { expectedRevision: 1, leaseOwnerId: 'real-worker' });
  release(); await cancelling;
  expect(await store.load(before.runId, config.scope)).toEqual(completed);
  await store.releaseLease!(before.runId, 'real-worker', config.scope);
}));

test('abort during initial task invocation save is persisted before operation admission', () => fixture(async ({ store }, config) => {
  let paused!: () => void, release!: () => void, intercepted = false, observedClosed: boolean | undefined;
  const ready = new Promise<void>(resolve => { paused = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      const account = args[0].metadata?.[TASK_BUDGET_ACCOUNT_KEY] as { invocation?: unknown } | undefined;
      if (!intercepted && account?.invocation) { intercepted = true; paused(); await gate; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const account = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'initial-abort',
    policy: { limits: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } } });
  const controller = new AbortController();
  const running = account.run('initial-abort', async signal => {
    observedClosed = (await account.summary()).admissionsClosed;
    signal.throwIfAborted();
  }, { signal: controller.signal });
  running.catch(() => {});
  await ready; controller.abort(); release();
  await expect(running).rejects.toThrow();
  expect(observedClosed === undefined || observedClosed).toBe(true);
  expect((await account.summary()).admissionsClosed).toBe(true);
}));

const limits = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 };
const barrier = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};

test('host cancel persists before abort and acknowledgement, and synchronously fences new tools', () => fixture(async ({ store }, config) => {
  const entered = barrier(), release = barrier(), closeSave = barrier(), allowSave = barrier();
  let signal!: AbortSignal, ack = false, invoked = 0;
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      const a = args[0].metadata?.[TASK_BUDGET_ACCOUNT_KEY] as { admissionsClosed?: boolean; invocation?: unknown } | undefined;
      if (a?.admissionsClosed && a.invocation) { closeSave.release(); await allowSave.promise; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const account = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'durable-close', policy: { limits } });
  const observer = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'durable-close', policy: { limits }, requireExisting: true });
  const running = account.run('r', async current => {
    signal = current; entered.release(); await release.promise;
    const tool = account.wrapTools({ effect: { description: 'effect', parameters: { type: 'object' }, execute: async () => { invoked++; return 'done'; } } } as any).effect!;
    await expect((tool as any).execute({})).rejects.toThrow();
  });
  running.catch(() => {}); await entered.promise;
  const cancel = observer.requestCancellation('r').then(() => { ack = true; });
  await closeSave.promise;
  expect(signal.aborted).toBe(false); expect(ack).toBe(false);
  release.release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(invoked).toBe(0);
  allowSave.release(); await cancel;
  expect(signal.aborted).toBe(true);
  await expect(running).rejects.toThrow();
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, invocationPending: false, confirmed: { totalTokens: 0 } });
  expect(await account.cancellations()).toMatchObject([{ runId: 'r', origin: 'operator', localExecution: 'native_tools_drained', remoteExecution: 'unconfirmed' }]);
}));

test('duplicate cancellation during invocation cleanup preserves one durable intent', () => fixture(async ({ store }, config) => {
  const entered = barrier(), release = barrier(), cleanup = barrier(), finishCleanup = barrier();
  let claimed = false;
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      const a = args[0].metadata?.[TASK_BUDGET_ACCOUNT_KEY] as { invocation?: unknown; cancellations?: unknown[] } | undefined;
      if (a?.invocation) claimed = true;
      if (claimed && a && !a.invocation) { cleanup.release(); await finishCleanup.promise; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const account = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'duplicate', policy: { limits } });
  const running = account.run('r', async () => { entered.release(); await release.promise; });
  running.catch(() => {}); await entered.promise;
  await account.requestCancellation('r'); release.release(); await cleanup.promise;
  await account.requestCancellation('r');
  finishCleanup.release(); await expect(running).rejects.toThrow();
  expect(await account.cancellations()).toHaveLength(1);
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, invocationPending: false });
}));

test('cancelling an older run cannot close a newer invocation of the same task', () => fixture(async ({ store }, config) => {
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'newer', policy: { limits } });
  await account.run('old', async () => {});
  const entered = barrier(), release = barrier();
  const running = account.run('new', async signal => { entered.release(); await release.promise; expect(signal.aborted).toBe(false); });
  await entered.promise;
  await expect(account.requestCancellation('old')).rejects.toThrow('TASK_BUDGET_ACTIVE');
  expect(await account.summary()).toMatchObject({ admissionsClosed: false, activeRunId: 'new' });
  release.release(); await running;
  expect(await account.cancellations()).toEqual([]);
}));

test('abort during cleanup save records intent without recreating a pending invocation', () => fixture(async ({ store }, config) => {
  const cleanup = barrier(), finishCleanup = barrier(); let claimed = false;
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      const a = args[0].metadata?.[TASK_BUDGET_ACCOUNT_KEY] as { invocation?: unknown } | undefined;
      if (a?.invocation) claimed = true;
      if (claimed && a && !a.invocation) { cleanup.release(); await finishCleanup.promise; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const account = await TaskBudget.open({ store: delayed, scope: config.scope, taskId: 'cleanup-abort', policy: { limits } });
  const controller = new AbortController();
  const running = account.run('r', async () => 'completed local work', { signal: controller.signal });
  await cleanup.promise; controller.abort(); finishCleanup.release();
  expect(await running).toBe('completed local work');
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, invocationPending: false });
  expect(await account.cancellations()).toMatchObject([{ runId: 'r', origin: 'abort', localExecution: 'native_tools_drained' }]);
}));

test('a separate SQLite worker completing during cancellation save preserves terminal evidence', () => fixture(async ({ store }, config) => {
  const before = state(config, 'running'); await store.save(before, { expectedRevision: 0 });
  const paused = barrier(), release = barrier(); let intercepted = false;
  const delayed = new Proxy(store, { get(target, key) {
    if (key === 'save') return async (...args: Parameters<typeof target.save>) => {
      if (!intercepted && args[0].status === 'cancel_requested') { intercepted = true; paused.release(); await release.promise; }
      return target.save(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = cancelHarnessRun(delayed, config, before.runId); await paused.promise;
  const child = Bun.spawn([process.execPath, '--eval', `
    import { openHarnessPersistence } from ${JSON.stringify(new URL('../src/persistence/operations.ts', import.meta.url).pathname)};
    const config = ${JSON.stringify(config)};
    const p = await openHarnessPersistence(config);
    if (!await p.store.acquireLease('terminal', {ownerId:'child-worker',ttlMs:30000},config.scope)) throw new Error('no lease');
    const state = await p.store.load('terminal',config.scope);
    await p.store.save({...state,status:'completed',revision:2},{expectedRevision:1,leaseOwnerId:'child-worker'});
    await p.store.releaseLease('terminal','child-worker',config.scope); p.close();
  `], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' });
  const [exit, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  release.release(); const result = await pending;
  expect(exit, errors).toBe(0);
  expect(await store.load(before.runId, config.scope)).toEqual({ ...before, status: 'completed', revision: 2 });
  expect('run' in result ? result.run?.status : undefined).toBe('completed');
}));

test('SIGKILL after acknowledged intent retains cancellation and admitted exposure on restart', () => fixture(async ({ store }, config) => {
  const child = Bun.spawn([process.execPath, '--eval', `
    import { TaskBudget } from ${JSON.stringify(new URL('../src/runtime/task-budget.ts', import.meta.url).pathname)};
    import { openHarnessPersistence } from ${JSON.stringify(new URL('../src/persistence/operations.ts', import.meta.url).pathname)};
    import { wrapLanguageModel } from '@zhivex-ai/core';
    const config=${JSON.stringify(config)}; const p=await openHarnessPersistence(config);
    const a=await TaskBudget.open({store:p.store,scope:config.scope,taskId:'killed',policy:{limits:${JSON.stringify(limits)}}});
    const model={provider:'mock',modelId:'pending',generate:async()=>{
      await a.requestCancellation('killed-run'); process.stdout.write('durable-intent\\n');
      await new Promise(()=>{});
    }};
    setInterval(()=>{},1000);
    await a.run('killed-run',()=>wrapLanguageModel(model,[a.middleware()]).generate({messages:[{role:'user',parts:[{type:'text',text:'fixture'}]}],maxTokens:10}));
  `], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  try { const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('durable-intent'); }
  finally { child.kill('SIGKILL'); await child.exited; reader.releaseLock(); }
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'killed', policy: { limits }, requireExisting: true, now: () => Date.now() + 60000 });
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, invocationPending: true, usageComplete: false });
  expect((await account.summary()).reserved.totalTokens).toBeGreaterThan(0);
  expect(await account.cancellations()).toMatchObject([{ runId: 'killed-run', origin: 'operator', localExecution: 'unconfirmed', remoteExecution: 'unconfirmed' }]);
  await expect(account.requestCancellation('killed-run')).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
  await expect(account.run('retry', async () => {})).rejects.toThrow('TASK_BUDGET_INVOCATION_UNCERTAIN');
}));

test('complete logical import preserves cancellation evidence and closes late admissions', () => fixture(async ({ store }, config) => {
  const { createHarnessStateBackup, importHarnessStateBackup } = await import('../src/persistence/state-backup.js');
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'imported', policy: { limits } });
  const entered = barrier(), finish = barrier();
  const pending = account.run('r', async () => { entered.release(); await finish.promise; }); pending.catch(() => {});
  await entered.promise; await account.requestCancellation('r'); finish.release(); await expect(pending).rejects.toThrow();
  const before = await account.cancellations(), bundle = await createHarnessStateBackup(config);
  const targetConfig = { ...config, stateDirectory: config.workspace + '/imported' };
  await importHarnessStateBackup(targetConfig, bundle);
  const target = await openHarnessPersistence(targetConfig);
  try {
    const imported = await TaskBudget.open({ store: target.store, scope: config.scope, taskId: 'imported', policy: { limits }, requireExisting: true });
    expect(await imported.cancellations()).toEqual(before);
    expect(await imported.summary()).toMatchObject({ admissionsClosed: true, invocationPending: false });
    await expect(imported.run('late', async () => {})).rejects.toThrow('TASK_BUDGET_CANCELLED');
  } finally { target.close(); }
}));

test('an admitted native process keeps invocation pending until exit and preserves its written effect', () => fixture(async ({ store }, config) => {
  const { z } = await import('zod');
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'process', policy: { limits } });
  const ready = barrier(), release = barrier(); let exited = false;
  const tools = account.wrapTools({ native: { name: 'native', description: 'real native process', schema: z.object({}), execute: async () => {
    const child = Bun.spawn([process.execPath, '--eval', `
      await Bun.write(${JSON.stringify(config.workspace + '/effect.txt')},'effect already written');
      process.stdout.write('started'); process.stdin.resume(); process.stdin.once('data',()=>process.exit(0));
    `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe('started'); ready.release(); await release.promise;
      child.stdin.write('finish'); child.stdin.end(); expect(await child.exited).toBe(0); exited = true; return 'process finished'; }
    finally { child.kill(); await child.exited; reader.releaseLock(); }
  } } });
  const pending = account.run('native-run', async () => {
    if ('execute' in tools.native!) await tools.native.execute!({}, {} as any);
  }); pending.catch(() => {}); await ready.promise;
  try {
    await account.requestCancellation('native-run');
    expect(exited).toBe(false);
    expect((await account.summary()).invocationPending).toBe(true);
    expect((await account.cancellations())[0]?.localExecution).toBe('unconfirmed');
    expect(await Bun.file(config.workspace + '/effect.txt').text()).toBe('effect already written');
  } finally { release.release(); }
  await expect(pending).rejects.toThrow();
  expect((await account.summary()).invocationPending).toBe(false);
  expect((await account.cancellations())[0]?.localExecution).toBe('native_tools_drained');
  expect(await Bun.file(config.workspace + '/effect.txt').text()).toBe('effect already written');
}));

test('cancellation after an asynchronous tool ownership check still refuses the native callback', () => fixture(async ({ store }, config) => {
  const { z } = await import('zod');
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'tool-boundary', policy: { limits } });
  const checked = barrier(), proceed = barrier(); let effects = 0;
  const original = account.assertOwnership.bind(account);
  account.assertOwnership = async options => { await original(options); if (!options?.allowCancelled) { checked.release(); await proceed.promise; } };
  const tools = account.wrapTools({ effect: { name: 'effect', description: 'effect', schema: z.object({}), execute: async () => { effects++; return 'wrote'; } } });
  const pending = account.run('r', async () => { if ('execute' in tools.effect!) await tools.effect.execute!({}, {} as any); }); pending.catch(() => {});
  await checked.promise; await account.requestCancellation('r'); proceed.release();
  await expect(pending).rejects.toThrow(); expect(effects).toBe(0);
}));

for (const route of ['generate', 'stream'] as const)
test(`cancellation between final ownership check and ${route} dispatch releases only undispatched credit`, () => fixture(async ({ store }, config) => {
  const { wrapLanguageModel } = await import('@zhivex-ai/core');
  const { createMockLanguageModel } = await import('@zhivex-ai/agents/testing');
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: route + '-boundary', policy: { limits } });
  const checked = barrier(), proceed = barrier(); let checks = 0, requests = 0;
  const original = account.assertOwnership.bind(account);
  account.assertOwnership = async options => {
    await original(options);
    if (!options?.allowCancelled && ++checks === 2) { checked.release(); await proceed.promise; }
  };
  const model = createMockLanguageModel();
  model.generate = async () => { requests++; throw new Error('unreachable'); };
  model.stream = async () => { requests++; throw new Error('unreachable'); };
  const wrapped = wrapLanguageModel(model, [account.middleware()]);
  const pending = account.run('r', async () => { await wrapped[route]!({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'fixture' }] }] }); }); pending.catch(() => {});
  await checked.promise; await account.requestCancellation('r'); proceed.release();
  await expect(pending).rejects.toThrow(); expect(requests).toBe(0);
  expect(await account.summary()).toMatchObject({ usageComplete: true, remaining: limits, admissionsClosed: true });
}));
