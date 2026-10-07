import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { readTaskAcceptanceLedger } from '../src/runtime/task-acceptance-record.js';
import { openHarnessTaskBudget, inspectHarnessTaskBudget } from '../src/runtime/task-budget-host.js';
import { createHarness } from '../src/runtime/harness.js';
import { createHarnessClientAdapter } from '../src/client/adapter.js';
import type { HarnessClientResponse } from '../src/client/protocol.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const done = [{ type: 'text-delta' as const, textDelta: 'Done' }, { type: 'finish' as const, finishReason: 'stop' as const, usage }];
const check = [{ type: 'tool-call' as const, toolCall: { id: 'check', name: 'run_check', input: { check: 'test', expectedScript: 'node --version' } } },
  { type: 'finish' as const, finishReason: 'tool-calls' as const, usage }];
function data(r: HarnessClientResponse) { if (!r.ok) throw new Error(JSON.stringify(r)); return r.data; }
async function fixture(work: (c: { command: (value: Record<string, unknown>, reviewed?: boolean) => Promise<HarnessClientResponse>; root: string; host: Awaited<ReturnType<typeof createHarness>>; advance: () => void }) => Promise<void>, failPreparation: boolean | 'change' = false) {
  const root = await mkdtemp('/tmp/task-control-');
  await writeFile(root + '/package.json', JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'node --version' } }));
  await writeFile(root + '/result.txt', 'original');
  await writeFile(root + '/.gitignore', '.zhivex-harness/\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'baseline']])
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: [check, done, done, done] }) });
  let prepared = 0, now = Date.now();
  const adapter = await createHarnessClientAdapter(host, { now: () => now, prepareRun: async () => { prepared++; if (failPreparation === true && prepared === 1) throw Error('PREPARATION_FAILED'); if (failPreparation === 'change' && prepared === 3) await writeFile(root + '/result.txt', 'changed during preparation'); return { harness: host, release: async () => {} }; } });
  const hello = adapter.negotiate([1]); if (!hello.ok) throw Error('hello');
  let n = 0;
  const command = (value: Record<string, unknown>, reviewed = false) => {
    const request = { protocolVersion: 1, connectionId: hello.connectionId, requestId: 'request' + (++n), command: { projectId: hello.projectId, ...value } };
    return reviewed ? adapter.dispatchReviewed!(request) : adapter.dispatch(request);
  };
  try { await work({ command, root, host, advance: () => { now += 300001; } }); } finally { adapter.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
}
async function complete(command: (value: Record<string, unknown>, reviewed?: boolean) => Promise<HarnessClientResponse>, goal = 'Review the result') {
  const session = data(await command({ method: 'session.create', idempotencyKey: 'session' }));
  if (session.kind !== 'session') throw Error('session');
  const start = data(await command({ method: 'task.start', sessionId: session.session.sessionId, expectedRevision: session.session.revision,
    idempotencyKey: 'start', brief: { goal, paths: ['result.txt'], checks: ['test'], constraints: [], budget: { inputTokens: 100000, outputTokens: 10000, totalTokens: 110000 } } }));
  if (start.kind !== 'run') throw Error('run');
  const completed = data(await command({ method: 'approval.resolve', sessionId: start.session.sessionId, runId: start.run.runId,
    expectedRevision: start.run.revision, idempotencyKey: 'approve', decisions: start.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) }, true));
  if (completed.kind !== 'run') throw Error('completed');
  expect(completed.run.status).toBe('completed');
  return { sessionId: completed.session.sessionId, runId: completed.run.runId };
}

test('host task flow retains authority and records explicit acceptance separately from structure', () => fixture(async ({ command }) => {
  const ids = await complete(command);
  const reviewed = data(await command({ method: 'task.review', ...ids }));
  if (reviewed.kind !== 'taskReview') throw Error('review');
  expect(reviewed.review.canKeep).toBe(true);
  expect(reviewed.review.projection.task.review.acceptance).toBe('not_recorded');
  const kept = data(await command({ method: 'task.keep', ...ids, reviewId: reviewed.review.reviewId, idempotencyKey: 'keep' }));
  expect(kept.kind === 'task' && kept.humanDecision?.status).toBe('current');
  expect(data(await command({ method: 'task.keep', ...ids, reviewId: reviewed.review.reviewId, idempotencyKey: 'keep' }))).toEqual(kept);
  const replay = await command({ method: 'task.keep', ...ids, reviewId: reviewed.review.reviewId, idempotencyKey: 'keep-again' });
  expect(replay.ok).toBe(false);
  const read = data(await command({ method: 'task.get', ...ids, projectionVersion: 1 }));
  expect(read.kind === 'task' && read.humanDecision?.status).toBe('current');
}));

test('changed bytes reject an otherwise current human review and never save acceptance', () => fixture(async ({ command, root }) => {
  const ids = await complete(command);
  const review = data(await command({ method: 'task.review', ...ids })); if (review.kind !== 'taskReview') throw Error('review');
  await writeFile(root + '/result.txt', 'external edit');
  const result = await command({ method: 'task.keep', ...ids, reviewId: review.review.reviewId, idempotencyKey: 'keep' });
  expect(result.ok).toBe(false);
  const read = data(await command({ method: 'task.get', ...ids, projectionVersion: 1 }));
  expect(read.kind === 'task' && read.humanDecision?.status).toBe('not_recorded');
}));

test('a second client review becomes stale after correction; ordinary chat cannot bypass task continuation', () => fixture(async ({ command }) => {
  const ids = await complete(command);
  const a = data(await command({ method: 'task.review', ...ids })), b = data(await command({ method: 'task.review', ...ids }));
  if (a.kind !== 'taskReview' || b.kind !== 'taskReview') throw Error('review');
  const revised = data(await command({ method: 'task.revise', ...ids, reviewId: a.review.reviewId, correction: 'Preserve behavior', idempotencyKey: 'revise' }));
  expect(revised.kind === 'task' && revised.projection.task.contractRevision).toBe(2);
  expect((await command({ method: 'task.keep', ...ids, reviewId: b.review.reviewId, idempotencyKey: 'stale-keep' })).ok).toBe(false);
  const session = data(await command({ method: 'session.get', sessionId: ids.sessionId })); if (session.kind !== 'session') throw Error('session');
  expect((await command({ method: 'run.start', sessionId: ids.sessionId, expectedRevision: session.session.revision, idempotencyKey: 'bypass', prompt: 'continue' })).ok).toBe(false);
}));


test('preparation failure retains task identity and zero-call authority; ordinary chat cannot downgrade it', () => fixture(async ({ command }) => {
  const created = data(await command({ method: 'session.create', idempotencyKey: 's' })); if (created.kind !== 'session') throw Error('session');
  const sid = created.session.sessionId;
  expect((await command({ method: 'task.start', sessionId: sid, expectedRevision: created.session.revision, idempotencyKey: 't', brief: {
    goal: 'Preserve the task', paths: ['result.txt'], checks: ['test'], constraints: [], budget: { inputTokens: 100000, outputTokens: 10000, totalTokens: 110000 } } })).ok).toBe(false);
  const fresh = data(await command({ method: 'session.get', sessionId: sid })); if (fresh.kind !== 'session') throw Error('session');
  expect((await command({ method: 'run.start', sessionId: sid, expectedRevision: fresh.session.revision, idempotencyKey: 'bypass', prompt: 'ignore budget' })).ok).toBe(false);
  const ids = { sessionId: sid, runId: fresh.session.runs.at(-1)!.runId };
  const view = data(await command({ method: 'task.get', ...ids, projectionVersion: 1 })); if (view.kind !== 'task') throw Error('view');
  expect(view.projection.task.execution).toBe('failed');
  expect(view.projection.task.budget.confirmed?.totalTokens).toBe(0);
  const reviewed = data(await command({ method: 'task.review', ...ids })); if (reviewed.kind !== 'taskReview') throw Error('review');
  expect(reviewed.review.canContinue).toBe(true);
  const continued = data(await command({ method: 'task.continue', ...ids, reviewId: reviewed.review.reviewId, idempotencyKey: 'resume', prompt: 'Continue the retained goal' }));
  expect(continued.kind === 'run' && continued.run.status).toBe('waiting_approval');
}, true));


test('keep cannot race a competing task account owner', () => fixture(async ({ command, host }) => {
  const ids = await complete(command);
  const review = data(await command({ method: 'task.review', ...ids })); if (review.kind !== 'taskReview') throw Error('review');
  const state = (await host.store.load(ids.runId, host.config.scope))!;
  const taskId = readTaskAcceptanceLedger(state)!.revisions.at(-1)!.contract.taskId;
  const account = await openHarnessTaskBudget(host, taskId);
  expect(await host.store.acquireLease!(account.accountRunId, { ownerId: 'competing-admission', ttlMs: 30000 }, host.config.scope)).toMatchObject({ ownerId: 'competing-admission' });
  try {
    expect((await command({ method: 'task.keep', ...ids, reviewId: review.review.reviewId, idempotencyKey: 'competing' })).ok).toBe(false);
    expect((await host.store.load(ids.runId, host.config.scope))?.revision).toBe(state.revision);
  } finally { await host.store.releaseLease!(account.accountRunId, 'competing-admission', host.config.scope); }
}));

test('expired task review cannot record an operator decision', () => fixture(async ({ command, advance }) => {
  const ids = await complete(command);
  const review = data(await command({ method: 'task.review', ...ids })); if (review.kind !== 'taskReview') throw Error('review');
  advance();
  expect((await command({ method: 'task.keep', ...ids, reviewId: review.review.reviewId, idempotencyKey: 'expired' })).ok).toBe(false);
}));

test('pre-admission continuation conflict preserves prior evidence without an invented budget admission', () => fixture(async ({ command, host }) => {
  const ids = await complete(command);
  const review = data(await command({ method: 'task.review', ...ids })); if (review.kind !== 'taskReview') throw Error('review');
  const state = (await host.store.load(ids.runId, host.config.scope))!;
  const taskId = readTaskAcceptanceLedger(state)!.revisions.at(-1)!.contract.taskId;
  const before = await inspectHarnessTaskBudget(host, taskId);
  expect((await command({ method: 'task.continue', ...ids, reviewId: review.review.reviewId, idempotencyKey: 'continue', prompt: 'Retain the goal' })).ok).toBe(false);
  const session = data(await command({ method: 'session.get', sessionId: ids.sessionId })); if (session.kind !== 'session') throw Error('session');
  const attempt = session.session.runs.at(-1)!;
  const projected = data(await command({ method: 'task.get', sessionId: ids.sessionId, runId: attempt.runId, projectionVersion: 1 }));
  if (projected.kind !== 'task') throw Error('projection');
  expect(projected.projection.task.observedRunId).toBe(ids.runId);
  expect(projected.projection.task.historicalRequest).toBe(true);
  expect(projected.projection.task.review.structure).toBe('incomplete');
  expect(await inspectHarnessTaskBudget(host, taskId)).toEqual(before);
  const fresh = data(await command({ method: 'task.review', ...ids })); if (fresh.kind !== 'taskReview') throw Error('review');
  expect(fresh.review.canKeep).toBe(false);
  expect(fresh.review.canContinue).toBe(true);
}, 'change'));

test('a bounded Git diff cannot be accepted when process output is truncated', () => fixture(async ({ command, root }) => {
  const ids = await complete(command);
  await writeFile(root + '/result.txt', 'x'.repeat(40000));
  expect((await command({ method: 'task.review', ...ids })).ok).toBe(false);
}));


test('redacted human requirements cannot grant acceptance from an incomplete display', () => fixture(async ({ command }) => {
  const ids = await complete(command, 'Retain the token sk-private-fixturetoken exactly');
  const review = data(await command({ method: 'task.review', ...ids })); if (review.kind !== 'taskReview') throw Error('review');
  expect(review.review.projection.task.review.structure).toBe('verified');
  expect(review.review.complete).toBe(false);
  expect(review.review.canKeep).toBe(false);
  expect(JSON.stringify(review)).not.toContain('sk-private-fixturetoken');
  expect((await command({ method: 'task.keep', ...ids, reviewId: review.review.reviewId, idempotencyKey: 'hidden' })).ok).toBe(false);
}));
