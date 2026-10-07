import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import type { StreamEvent } from '@zhivex-ai/core';
import { createHarness, runHarness, runHarnessTask } from '../src/runtime/harness.js';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget } from '../src/runtime/task-budget-host.js';
import { taskAcceptanceContractSchema } from '../src/runtime/task-acceptance.js';
import { TASK_BUDGET_KEY } from '../src/runtime/task-budget.js';
import { createHarnessClientAdapter } from '../src/client/adapter.js';
import { openCliSessionStore } from '../src/persistence/sessions.js';
import { reduceHarnessTaskProjection, type HarnessTaskProjection } from '../src/client/task-projection.js';
import { reviseHarnessTaskAcceptance } from '../src/runtime/task-acceptance-host.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const done: StreamEvent[] = [{ type: 'text-delta', textDelta: 'untrusted claimed success' }, { type: 'finish', finishReason: 'stop', usage }];
const check: StreamEvent[] = [{ type: 'tool-call', toolCall: { id: 'check', name: 'run_check', input: { check: 'test', expectedScript: 'node --version' } } }, { type: 'finish', finishReason: 'tool-calls', usage }];
const contract = taskAcceptanceContractSchema.parse({ schemaVersion: 1, taskId: 'projection', allowedWritePaths: ['result.txt'], protectedFiles: ['package.json'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node --version', command: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'fixture', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'human', requirement: 'Review behavior', status: 'pending' }] });

async function fixture(work: (context: {
  root: string; host: Awaited<ReturnType<typeof createHarness>>; sessions: Awaited<ReturnType<typeof openCliSessionStore>>;
  sessionId: string; adapter: Awaited<ReturnType<typeof createHarnessClientAdapter>>;
  read: (extra?: Record<string, unknown>) => ReturnType<Awaited<ReturnType<typeof createHarnessClientAdapter>>['dispatch']>;
  snapshot: () => Promise<HarnessTaskProjection>;
}) => Promise<void>, options: { legacy?: boolean; checked?: boolean; unknownSecond?: boolean } = {}) {
  const root = await mkdtemp('/tmp/task-projection-');
  await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  await writeFile(root + '/result.txt', 'original');
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: options.checked ? [check, done, done] : options.unknownSecond ? [done, [{ type: 'finish', finishReason: 'stop' }]] : [done, done] }) });
  const sessions = await openCliSessionStore({ workspace: root, stateDirectory: host.config.stateDirectory, scope: host.config.scope });
  const session = await sessions.create();
  if (!options.legacy) await initializeHarnessTaskBudget(host, contract.taskId);
  await (options.legacy ? runHarness : runHarnessTask)(host, { runId: 'first', prompt: 'Operator objective SECRET_FIXTURE sk-privatefixture path:/tmp/punctuated-alias [/tmp/bracket-alias] \\\\server\\share /tmp/retained-workspace-alias C:\\private\\workspace ' + root }, {
    taskAcceptance: contract, ...(!options.legacy ? { taskBudgetExisting: true } : {}),
    resolveApprovals: async approvals => approvals.map(item => ({ provider: item.provider, approvalRequestId: item.id, approve: true }))
  });
  await sessions.appendRun(session.sessionId, { runId: 'first', provider: 'mock', model: 'mock', status: 'completed' }, { expectedRevision: session.revision });
  const adapter = await createHarnessClientAdapter(host, { taskProjectionSensitiveValues: ['SECRET_FIXTURE'] });
  const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error('fixture negotiation');
  expect(hello.capabilities).toContain('task.projection.v1');
  let requests = 0;
  const read = (extra: Record<string, unknown> = {}) => adapter.dispatch({ protocolVersion: 1, connectionId: hello.connectionId, requestId: `read${++requests}`,
    command: { method: 'task.get', projectId: hello.projectId, sessionId: session.sessionId, runId: 'first', projectionVersion: 1, ...extra } });
  const snapshot = async () => { const result = await read(); if (!result.ok || result.data.kind !== 'task') throw new Error(JSON.stringify(result)); return result.data.projection; };
  try { await work({ root, host, sessions, sessionId: session.sessionId, adapter, read, snapshot }); }
  finally { adapter.close(); sessions.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
}

test('current deterministic receipt is separate from semantic and human acceptance; reads preserve state, budget and bytes', () => fixture(async c => {
  const before = JSON.stringify([await c.sessions.get(c.sessionId), await c.host.store.load('first', c.host.config.scope), await inspectHarnessTaskBudget(c.host, contract.taskId)]);
  const p = await c.snapshot();
  expect(p.task.review).toMatchObject({ structure: 'verified', semantic: 'pending', acceptance: 'not_recorded', checks: [{ status: 'confirmed' }], human: [{ status: 'pending' }] });
  expect(p.task.artifact.correspondence).toBe('current');
  expect(p.task.nextAction).toMatchObject({ kind: 'review_delivery', permitted: 'read_only', automaticReplay: false });
  expect(p.task.budget.confirmed?.totalTokens).toBe(30);
  expect(JSON.stringify(p)).not.toContain('SECRET_FIXTURE'); expect(JSON.stringify(p)).not.toContain('sk-privatefixture'); expect(JSON.stringify(p)).not.toContain(c.root);
  expect(JSON.stringify(p)).not.toContain('/tmp/retained-workspace-alias'); expect(JSON.stringify(p)).not.toContain('private\\\\workspace');
  expect(JSON.stringify(p)).not.toContain('/tmp/punctuated-alias'); expect(JSON.stringify(p)).not.toContain('/tmp/bracket-alias'); expect(JSON.stringify(p)).not.toContain('server');
  expect(JSON.stringify(p)).not.toContain('untrusted claimed success');
  await c.snapshot();
  expect(JSON.stringify([await c.sessions.get(c.sessionId), await c.host.store.load('first', c.host.config.scope), await inspectHarnessTaskBudget(c.host, contract.taskId)])).toBe(before);
  expect(await readFile(c.root + '/result.txt', 'utf8')).toBe('original');
}, { checked: true }));

test('drift and revised contract invalidate current checks without rerunning them', () => fixture(async c => {
  const initial = await c.snapshot();
  await writeFile(c.root + '/result.txt', 'changed');
  const drift = await c.snapshot(); expect(drift.task.artifact.correspondence).toBe('stale'); expect(drift.task.review.structure).toBe('incomplete');
  expect(drift.task.review.checks[0]?.status).toBe('missing_or_stale');
  const state = (await c.host.store.load('first', c.host.config.scope))!;
  await reviseHarnessTaskAcceptance(c.host, { runId: 'first', expectedRunRevision: state.revision!, expectedContractRevision: 1,
    contract: { ...contract, humanReview: [{ id: 'new', requirement: 'Revised review', status: 'pending' }] } });
  const revised = await c.snapshot(); expect(revised.task.contractRevision).toBe(2); expect(revised.task.contractDigest).not.toBe(initial.task.contractDigest);
  expect(revised.task.review.acceptance).toBe('not_recorded');
}, { checked: true }));

test('legacy contracts retain an explicit absent budget; missing or corrupt bound budgets never fall back', () => fixture(async c => {
  const p = await c.snapshot(); expect(p.task.budget.availability).toBe('legacy_not_enabled'); expect(p.task.budget.confirmed).toBeNull();
  const state = (await c.host.store.load('first', c.host.config.scope))!;
  await c.host.store.save({ ...state, metadata: { ...state.metadata, [TASK_BUDGET_KEY]: { schemaVersion: 999 } } }, { expectedRevision: state.revision! });
  expect(await c.read()).toMatchObject({ ok: false, error: { taskDiagnostic: { cause: 'EVIDENCE_UNAVAILABLE', safeAction: 'reconcile' } } });
}, { legacy: true }));

test('scope and unsupported projection version fail before journals; arbitrary artifact paths are never accepted', () => fixture(async c => {
  let journals = 0; const original = c.host.store.listToolCalls!.bind(c.host.store);
  c.host.store.listToolCalls = async (...args) => { journals++; return original(...args); };
  expect(await c.read({ projectionVersion: 2 })).toMatchObject({ ok: false, error: { code: 'VERSION_UNSUPPORTED', taskDiagnostic: { cause: 'UNSUPPORTED_VERSION' } } });
  expect(await c.read({ sessionId: 'other' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await c.read({ runId: 'foreign' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await c.read({ projectId: 'other' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await c.read({ artifactPath: '/private/secret' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  expect(journals).toBe(0);
}));

test('stripping a durable binding cannot hide an existing task account as legacy', () => fixture(async c => {
  const state = (await c.host.store.load('first', c.host.config.scope))!;
  const metadata = { ...state.metadata }; delete metadata[TASK_BUDGET_KEY];
  await c.host.store.save({ ...state, metadata }, { expectedRevision: state.revision! });
  expect(await c.read()).toMatchObject({ ok: false, error: { taskDiagnostic: { cause: 'EVIDENCE_UNAVAILABLE' } } });
}));

test('a missing latest durable run never presents an earlier delivery as the current verified structure', () => fixture(async c => {
  await runHarnessTask(c.host, { runId: 'second', prompt: 'Continue' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const session = (await c.sessions.get(c.sessionId))!;
  await c.sessions.appendRun(c.sessionId, { runId: 'second', provider: 'mock', model: 'mock', status: 'completed' }, { expectedRevision: session.revision });
  const original = c.host.store.load.bind(c.host.store);
  c.host.store.load = async (...args) => args[0] === 'second' ? undefined : original(...args);
  expect(await c.read()).toMatchObject({ ok: false, error: { taskDiagnostic: { cause: 'EVIDENCE_UNAVAILABLE' } } });
}, { checked: true }));

test('task accounts spanning another session are refused before any journal read', () => fixture(async c => {
  await runHarnessTask(c.host, { runId: 'foreign', prompt: 'Another session' }, { taskAcceptance: contract, taskBudgetExisting: true });
  const other = await c.sessions.create(); await c.sessions.appendRun(other.sessionId, { runId: 'foreign', provider: 'mock', model: 'mock', status: 'completed' }, { expectedRevision: other.revision });
  let journals = 0; c.host.store.listToolCalls = async () => { journals++; throw new Error('must not read'); };
  expect(await c.read()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', taskDiagnostic: { cause: 'OUT_OF_SCOPE' } } });
  expect(journals).toBe(0);
}));

test('unknown effects remain unreplayable and terminal errors have finite safe diagnostics', () => fixture(async c => {
  await c.host.store.saveToolCall!({ runId: 'first', scope: c.host.config.scope, toolCallId: 'effect', toolName: 'apply_patch', idempotencyKey: 'effect', revision: 1, status: 'running', updatedAt: 1 });
  const state = (await c.host.store.load('first', c.host.config.scope))!;
  await c.host.store.save({ ...state, status: 'failed', error: { message: 'PRIVATE sk-rawsecret /private/path' } }, { expectedRevision: state.revision! });
  const p = await c.snapshot(); expect(p.task.effects.unknown).toBe(1); expect(p.task.nextAction.kind).toBe('reconcile');
  expect(p.task.diagnostic).toMatchObject({ code: 'EXECUTION_FAILED', safeAction: 'reconcile' });
  expect(JSON.stringify(p)).not.toContain('PRIVATE'); expect(JSON.stringify(p)).not.toContain('sk-rawsecret');
}));

test('a changing input returns a safe read conflict without writing a replacement', () => fixture(async c => {
  const original = c.host.store.listToolCalls!.bind(c.host.store); let calls = 0;
  c.host.store.listToolCalls = async (...args) => { const rows = await original(...args); if (++calls === 2) await writeFile(c.root + '/result.txt', 'drift during read'); return rows; };
  expect(await c.read()).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT', taskDiagnostic: { cause: 'SNAPSHOT_CHANGED', safeAction: 'retry_read' } } });
}));

test('client projection replaces snapshots only within negotiated scope and admission order', () => fixture(async c => {
  const first = await c.snapshot(), next = await c.snapshot();
  const expected = { connectionId: first.connectionId, projectId: first.projectId, sessionId: first.sessionId, runId: first.runId };
  const applied = reduceHarnessTaskProjection(null, next, expected); expect(applied.status).toBe('applied');
  expect(reduceHarnessTaskProjection(applied.snapshot, first, expected).status).toBe('ignored');
  expect(reduceHarnessTaskProjection(applied.snapshot, next, expected).status).toBe('ignored');
  expect(reduceHarnessTaskProjection(applied.snapshot, { ...next, task: { ...next.task, objective: 'conflicting duplicate' } }, expected).status).toBe('refresh_required');
  expect(reduceHarnessTaskProjection(applied.snapshot, { ...next, schemaVersion: 2 }, expected).status).toBe('refresh_required');
  expect(reduceHarnessTaskProjection(applied.snapshot, next, { ...expected, connectionId: 'new_connection' })).toEqual({ status: 'refresh_required', snapshot: null });
  expect(reduceHarnessTaskProjection(applied.snapshot, next, { ...expected, sessionId: 'other' }).snapshot).toBeNull();
}));

test('slow earlier read cannot overwrite a later read admitted in the same connection', () => fixture(async c => {
  const original = c.host.store.load.bind(c.host.store); let first = true, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  c.host.store.load = async (...args) => { if (first && args[0] === 'first') { first = false; entered(); await gate; } return original(...args); };
  const older = c.snapshot(); await waiting;
  let newer: HarnessTaskProjection; try { newer = await c.snapshot(); } finally { release(); }
  const stale = await older;
  expect(stale.sequence).toBeLessThan(newer.sequence);
  expect(reduceHarnessTaskProjection(newer, stale, { connectionId: newer.connectionId, projectId: newer.projectId, sessionId: newer.sessionId, runId: newer.runId }).status).toBe('ignored');
}));

test('task reads remain available while an adapter mutation owns admission', () => fixture(async c => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const adapter = await createHarnessClientAdapter(c.host, { onPrompt: async () => { entered(); await gate; } });
  const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error('hello');
  const session = (await c.sessions.get(c.sessionId))!;
  const dispatch = (command: Record<string, unknown>) => adapter.dispatch({ protocolVersion: 1, requestId: 'busy-read', connectionId: hello.connectionId,
    command: { projectId: hello.projectId, sessionId: c.sessionId, ...command } });
  const pending = dispatch({ method: 'run.start', prompt: 'ordinary next turn', expectedRevision: session.revision, idempotencyKey: 'start' });
  await waiting;
  try {
    const before = JSON.stringify(await c.sessions.get(c.sessionId));
    expect(await dispatch({ method: 'task.get', runId: 'first', projectionVersion: 1 })).toMatchObject({ ok: true, data: { kind: 'task' } });
    expect(JSON.stringify(await c.sessions.get(c.sessionId))).toBe(before);
  } finally { release(); await pending; adapter.close(); }
}));

test('oversized journal fails with bounded diagnostics instead of leaking or claiming an empty history', () => fixture(async c => {
  c.host.store.listToolCalls = async () => Array.from({ length: 2049 }, () => ({ runId: 'first', toolCallId: 'oversized', toolName: 'PRIVATE', idempotencyKey: 'x', revision: 1, status: 'running' as const, updatedAt: 1 }));
  const result = await c.read(); expect(result).toMatchObject({ ok: false, error: { code: 'CAPACITY_EXCEEDED', taskDiagnostic: { cause: 'PAYLOAD_LIMIT' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
}));

test('unknown provider consumption is projected from the account without manufacturing remaining credit', () => fixture(async c => {
  try { await runHarnessTask(c.host, { runId: 'uncertain', prompt: 'Second invocation' }, { taskAcceptance: contract, taskBudgetExisting: true }); } catch { /* Missing usage can stop execution; inspect durable facts. */ }
  const state = (await c.host.store.load('uncertain', c.host.config.scope))!; expect(state).toBeDefined();
  const session = (await c.sessions.get(c.sessionId))!;
  await c.sessions.appendRun(c.sessionId, { runId: 'uncertain', provider: 'mock', model: 'mock', status: state.status as 'completed' }, { expectedRevision: session.revision });
  const budget = await inspectHarnessTaskBudget(c.host, contract.taskId), p = await c.snapshot();
  expect(budget.usageComplete).toBe(false); expect(budget.unknown.totalTokens + budget.reserved.totalTokens).toBeGreaterThan(0);
  expect(p.task.budget.unknown).toEqual(budget.unknown); expect(p.task.budget.reserved).toEqual(budget.reserved); expect(p.task.budget.remaining).toEqual(budget.remaining);
  expect(p.task.nextAction.kind).toBe('reconcile'); expect(p.task.nextAction.automaticReplay).toBe(false);
}, { unknownSecond: true }));
