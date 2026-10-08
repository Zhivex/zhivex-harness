import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { z } from 'zod';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { TaskBudget, TASK_BUDGET_ACCOUNT_KEY } from '../src/runtime/task-budget.js';
import { usagePricingSchema } from '../src/runtime/usage-ledger.js';

// Frozen HU70 decoder: 8b7327988984261290a7d07afd9c7a276c6a9085,
// src/runtime/task-budget.ts:15-22. Actual HU70 reader is also exercised in
// the separate cross-version process evidence; this fixture keeps CI offline.
const token = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.strictObject({ inputTokens: token, outputTokens: token, totalTokens: token });
const oldReader = z.strictObject({ schemaVersion: z.literal(1), taskId: z.string().min(1).max(256),
  policy: z.strictObject({ limits: tokens, closureReserve: z.number().min(0).max(0.9),
    usageAccounting: z.strictObject({ pricing: usagePricingSchema.optional(), limitUsd: z.number().finite().positive().optional(), requireCompleteUsage: z.boolean().optional() }).optional() }),
  runs: z.array(z.string().min(1).max(256)).max(4096), admissionsClosed: z.boolean(),
  invocation: z.strictObject({ runId: z.string().min(1).max(256), ownerId: z.string().min(1).max(256) }).optional() });
const policy = { limits: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, closureReserve: 0.3 };
async function fixture(work: (p: Awaited<ReturnType<typeof openHarnessPersistence>>, config: ReturnType<typeof resolveHarnessConfig>) => Promise<void>) {
  const root = await mkdtemp('/tmp/task-compat-'); const config = resolveHarnessConfig({ workspace: root, subagentProfiles: [] });
  const p = await openHarnessPersistence(config);
  try { await work(p, config); } finally { p.close(); await rm(root, { recursive: true, force: true }); }
}

test('HU71 reads HU70 v1 without writes and keeps uncancelled accounts downgrade-readable', () => fixture(async ({ store }, config) => {
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'old', policy });
  const before = (await store.load(account.accountRunId, config.scope))!;
  expect(oldReader.parse(before.metadata![TASK_BUDGET_ACCOUNT_KEY]).schemaVersion).toBe(1);
  const reopened = await TaskBudget.open({ store, scope: config.scope, taskId: 'old', policy, requireExisting: true });
  expect(await reopened.cancellations()).toEqual([]);
  expect(await store.load(account.accountRunId, config.scope)).toEqual(before);
  await reopened.run('r', async () => {});
  expect(oldReader.parse((await store.load(account.accountRunId, config.scope))!.metadata![TASK_BUDGET_ACCOUNT_KEY]).runs).toEqual(['r']);
}));

test('cancellation writes explicit v2; HU70 rejects safely without loss or mutation', () => fixture(async ({ store }, config) => {
  const taskId = 'private-task-payload';
  const account = await TaskBudget.open({ store, scope: config.scope, taskId, policy });
  await expect(account.run('r', async () => { await account.requestCancellation('r'); })).rejects.toThrow();
  const before = (await store.load(account.accountRunId, config.scope))!;
  const raw = before.metadata![TASK_BUDGET_ACCOUNT_KEY];
  expect(raw).toMatchObject({ schemaVersion: 2, admissionsClosed: true, cancellations: [{ runId: 'r' }] });
  const old = oldReader.safeParse(raw); expect(old.success).toBe(false);
  if (!old.success) { expect(old.error.issues.some(i => i.path[0] === 'schemaVersion')).toBe(true); expect(old.error.message).not.toContain(taskId); }
  expect(await store.load(account.accountRunId, config.scope)).toEqual(before);
  const reopened = await TaskBudget.open({ store, scope: config.scope, taskId, policy, requireExisting: true });
  expect(await reopened.cancellations()).toEqual(await account.cancellations());
  expect((await reopened.summary()).admissionsClosed).toBe(true);
}));

test('future account versions fail with a static diagnostic before any write', () => fixture(async ({ store }, config) => {
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'future', policy });
  const state = (await store.load(account.accountRunId, config.scope))!;
  const future = { ...state, revision: 2, metadata: { ...state.metadata, [TASK_BUDGET_ACCOUNT_KEY]: { ...(state.metadata![TASK_BUDGET_ACCOUNT_KEY] as object), schemaVersion: 99, secret: 'private-future-value' } } };
  await store.save(future, { expectedRevision: 1 });
  let error: unknown;
  try { await TaskBudget.open({ store, scope: config.scope, taskId: 'future', policy, requireExisting: true }); } catch (e) { error = e; }
  expect(String(error)).toContain('TASK_BUDGET_ACCOUNT_VERSION_UNSUPPORTED');
  expect(String(error)).not.toContain('private-future-value');
  expect(await store.load(account.accountRunId, config.scope)).toEqual(future);
}));

test('unpublished HU71 v0 history reads without mutation and upgrades only on the next owned write', () => fixture(async ({ store }, config) => {
  const account = await TaskBudget.open({ store, scope: config.scope, taskId: 'v0', policy });
  await account.run('prior', async () => {});
  const state = (await store.load(account.accountRunId, config.scope))!;
  const v0 = { ...state, revision: state.revision! + 1, metadata: { ...state.metadata,
    [TASK_BUDGET_ACCOUNT_KEY]: { ...(state.metadata![TASK_BUDGET_ACCOUNT_KEY] as object), schemaVersion: 1,
      admissionsClosed: true, cancellations: [{ runId: 'prior', requestedAt: 1, origin: 'operator' }] } } };
  await store.save(v0, { expectedRevision: state.revision! });
  const reopened = await TaskBudget.open({ store, scope: config.scope, taskId: 'v0', policy, requireExisting: true });
  expect(await reopened.cancellations()).toHaveLength(1);
  expect(await store.load(account.accountRunId, config.scope)).toEqual(v0);
  await reopened.reopen(v0.revision);
  expect((await store.load(account.accountRunId, config.scope))!.metadata![TASK_BUDGET_ACCOUNT_KEY]).toMatchObject({ schemaVersion: 2, cancellations: [{ runId: 'prior' }] });
}));
