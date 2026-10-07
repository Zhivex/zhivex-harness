import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { wrapLanguageModel, fingerprintAgentHarness, serializeJsonValue } from '@zhivex-ai/core';
import { ProviderToolCallError } from '@zhivex-ai/core/provider';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { TaskBudget } from '../src/runtime/task-budget.js';
import { UsageLedger, inspectTaskMonetaryUsage } from '../src/runtime/usage-ledger.js';

const pricing = { schemaVersion: 1 as const, prices: [{ provider: 'mock', model: 'accounting', inputUsdPerMillion: 0,
  outputUsdPerMillion: 1_000_000, source: 'synthetic dollars per token, not market pricing',
  asOf: '2000-01-01T00:00:00Z', expiresAt: '2100-01-01T00:00:00Z' }] };
const policy = { limits: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 }, closureReserve: 0.3 };
const request = () => ({ messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'fixture' }] }], maxTokens: 20 });
const model = () => createMockLanguageModel({ provider: 'mock', modelId: 'accounting', responses: [{
  text: 'ok', finishReason: 'stop', messages: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }] });
async function fixture(work: (value: { account: TaskBudget; ledger: UsageLedger; config: ReturnType<typeof resolveHarnessConfig>;
  persistence: Awaited<ReturnType<typeof openHarnessPersistence>> }) => Promise<void>, limitUsd = 500, priced = true) {
  const root = await mkdtemp('/tmp/hu70-accounting-');
  const config = resolveHarnessConfig({ workspace: root, storeBackend: 'sqlite', subagentProfiles: [] });
  const persistence = await openHarnessPersistence(config);
  const ledger = await UsageLedger.open(config, { limitUsd, ...(priced ? { pricing } : {}) });
  try {
    const account = await TaskBudget.open({ store: persistence.store, scope: config.scope, taskId: 'logical', policy });
    await ledger.run(account.accountRunId, async () => {});
    await work({ account, ledger, config, persistence });
  } finally { ledger.close(); persistence.close(); await rm(root, { recursive: true, force: true }); }
}

test('task monetary closure margin refuses work before dispatch and releases only proven undispatched tokens', async () => fixture(async ({ account, ledger }) => {
  let calls = 0;
  const transport = model(), generate = transport.generate;
  transport.generate = input => { calls++; return generate(input); };
  await expect(account.run('work', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(transport), [account.middleware()]).generate(request())))).rejects.toThrow('USAGE_COST_BUDGET');
  expect(calls).toBe(0);
  expect(await account.summary()).toMatchObject({ usageComplete: true, confirmed: { totalTokens: 0 }, remaining: policy.limits });
  await account.run('closure', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(transport), [account.middleware({ closure: () => true })]).generate(request())));
  expect(calls).toBe(1);
  expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ estimatedConfirmedUsd: 5, remainingUsd: 15, categories: ['closure'], costComplete: true });
}, 20));

test('three simultaneous primary/compaction admissions in one SQLite host cannot reuse reservations', async () => fixture(async ({ account, ledger }) => {
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = model(), generate = transport.generate;
  transport.generate = async input => { calls++; entered(); await gate; return generate(input); };
  await account.run('race', () => ledger.run(account.accountRunId, async () => {
    const wrapped = [false, true, false].map(auxiliary => wrapLanguageModel(ledger.model(transport), [account.middleware({ auxiliary })]));
    const attempts = wrapped.map(m => m.generate(request()));
    // Install rejection handlers before releasing the first transport.
    const settled = Promise.allSettled(attempts);
    await started;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect((await account.summary()).reserved.totalTokens).toBe(1470);
    expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ reservedCalls: 1, reservedUsd: 20, confirmedCalls: 0 });
    release();
    expect((await settled).filter(result => result.status === 'fulfilled')).toHaveLength(1);
  }));
  expect(await account.summary()).toMatchObject({ confirmed: { totalTokens: 15 }, reserved: { totalTokens: 0 }, usageComplete: true });
  expect(inspectTaskMonetaryUsage(ledger, account.accountRunId).estimatedConfirmedUsd).toBe(5);
}));

test('late receipt after abort is charged once and does not reopen task admission', async () => fixture(async ({ account, ledger }) => {
  const abort = new AbortController(), transport = model(), generate = transport.generate;
  transport.generate = async input => { abort.abort(); return generate(input); };
  await expect(account.run('aborted', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(transport), [account.middleware()]).generate(request())), { signal: abort.signal })).rejects.toThrow();
  expect(await account.summary()).toMatchObject({ admissionsClosed: true, confirmed: { totalTokens: 15 } });
  expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ confirmedCalls: 1, lateCalls: 1, estimatedConfirmedUsd: 5, reservedUsd: 0, unknownHeldUsd: 0 });
}));

test('partial failure retains unknown exposure across reopen; a revised policy cannot mint credit', async () => fixture(async ({ account, ledger, persistence, config }) => {
  const transport = model(); transport.generate = async () => { throw new Error('synthetic partial transport'); };
  await expect(account.run('partial', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(transport), [account.middleware()]).generate(request())))).rejects.toThrow();
  expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ unknownCalls: 1, unknownHeldUsd: 20, lateCalls: 0, costComplete: false });
  const reopened = await TaskBudget.open({ store: persistence.store, scope: config.scope, taskId: 'logical',
    policy: { ...policy, limits: { inputTokens: 99999, outputTokens: 99999, totalTokens: 199998 } }, requireExisting: true });
  expect((await reopened.summary()).limits).toEqual(policy.limits);
  await expect(reopened.run('retry', async () => {})).rejects.toThrow('TASK_BUDGET_UNCERTAIN');
  const other = await UsageLedger.open(config, { limitUsd: 99999 });
  try {
    expect(other.summary(account.accountRunId).limitUsd).toBe(500);
    expect(inspectTaskMonetaryUsage(other, account.accountRunId)).toMatchObject({ unknownHeldUsd: 20, costComplete: false });
  } finally { other.close(); }
}));

test('missing pricing refuses paid task admission without an invented charge or a token leak', async () => fixture(async ({ account, ledger }) => {
  await expect(account.run('unpriced', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(model()), [account.middleware()]).generate(request())))).rejects.toThrow('USAGE_PRICE_MISSING');
  expect(await account.summary()).toMatchObject({ usageComplete: true, remaining: policy.limits });
  expect(ledger.summary(account.accountRunId).calls).toBe(0);
}, 500, false));

test('a retained monetary receipt cannot hide a deleted token allocation', async () => fixture(async ({ account, ledger, persistence, config }) => {
  await account.run('charged', () => ledger.run(account.accountRunId, () =>
    wrapLanguageModel(ledger.model(model()), [account.middleware()]).generate(request())));
  const scope = { ...config.scope, namespace: '__zhivex_budget__' };
  const id = `budget_${fingerprintAgentHarness({ budgetId: account.accountRunId, scope: config.scope }).slice('sha256:'.length)}`;
  const stored = (await persistence.store.load(id, scope))!;
  const allocations = structuredClone(stored.metadata!.allocations) as Record<string, { tokens: { totalTokens: number } }>;
  for (const [key, entry] of Object.entries(allocations)) if (entry.tokens.totalTokens > 0) delete allocations[key];
  await persistence.store.save({ ...stored, revision: stored.revision! + 1,
    metadata: { ...stored.metadata, allocations: serializeJsonValue(allocations) } }, { expectedRevision: stored.revision! });
  await expect(account.assertMonetaryReceipts(ledger)).rejects.toThrow('TASK_BUDGET_TOKEN_ALLOCATIONS_MISSING');
}));

for (const mode of ['stream-open', 'stream-body', 'missing-finish', 'late-finish'] as const)
test(`both task ledgers preserve streaming evidence: ${mode}`, async () => fixture(async ({ account, ledger }) => {
  const abort = new AbortController(), transport = model();
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const error = new ProviderToolCallError({ provider: 'mock', reason: 'incomplete_arguments', diagnosticCode: 'FIXTURE',
    usage, usageComplete: true, providerRequestCount: 1 });
  transport.stream = async () => {
    if (mode === 'stream-open') { abort.abort(); throw error; }
    return (async function* () {
      yield { type: 'text-delta' as const, textDelta: 'partial' };
      if (mode === 'stream-body') { abort.abort(); throw error; }
      if (mode === 'late-finish') {
        abort.abort();
        yield { type: 'finish' as const, finishReason: 'stop' as const, usage };
      }
    })();
  };
  await expect(account.run(mode, () => ledger.run(account.accountRunId, async () => {
    const wrapped = wrapLanguageModel(ledger.model(transport), [account.middleware()]);
    for await (const _event of await wrapped.stream!(request())) { /* drain */ }
  }), { signal: abort.signal })).rejects.toThrow();
  await account.assertMonetaryReceipts(ledger);
  if (mode === 'missing-finish') {
    expect(await account.summary()).toMatchObject({ usageComplete: false, confirmed: { totalTokens: 0 }, unknown: { totalTokens: 1470 } });
    expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ unknownCalls: 1, unknownHeldUsd: 20, confirmedCalls: 0, costComplete: false });
  } else {
    expect(await account.summary()).toMatchObject({ admissionsClosed: true, usageComplete: true, confirmed: usage });
    expect(inspectTaskMonetaryUsage(ledger, account.accountRunId)).toMatchObject({ confirmedCalls: 1, lateCalls: 1, estimatedConfirmedUsd: 5, unknownHeldUsd: 0 });
  }
}));
