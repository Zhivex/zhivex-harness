import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, chmod, symlink } from 'node:fs/promises';
import { openTaskMetrics, type TaskRunSnapshot } from '../src/task-metrics.js';
import { startAssistantHost, connectAssistant } from '../src/index.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';

const snapshot = (runId: string, overrides: Partial<TaskRunSnapshot> = {}): TaskRunSnapshot => ({
  runId, sessionId: 'session', startedAt: 1000, updatedAt: 2000, status: 'completed',
  usage: { calls: 1, inputTokens: 100, outputTokens: 20, usageComplete: true, estimatedUsd: 0.01 }, ...overrides
});
test('timeouts finalize elapsed time, accept feedback and retain cost through correction and restart', async () => {
  const directory = await mkdtemp('/tmp/task-metrics-timeout-');
  let now = 5000;
  let store = await openTaskMetrics(directory, () => now);
  try {
    store.observe(snapshot('timeout', { status: 'timed_out' }));
    expect(store.get('timeout')).toMatchObject({ endedAt: 2000, durationMs: 1000, elapsedMs: 1000, costComplete: true, estimatedUsd: 0.01 });
    for (const outcome of ['failure', 'abandoned'] as const) {
      expect(store.feedback({ taskId: 'timeout', expectedRevision: store.get('timeout').revision, outcome, category: 'general' }).outcome).toBe(outcome);
    }
    store.close();
    now = 20000;
    store = await openTaskMetrics(directory, () => now);
    expect(store.get('timeout')).toMatchObject({ elapsedMs: 1000, outcome: 'abandoned' });
    store.observe(snapshot('fix', { startedAt: 3000, updatedAt: 4000 }));
    const linked = store.link({ taskId: 'timeout', runId: 'fix', kind: 'correction' });
    expect(linked).toMatchObject({ endedAt: 4000, elapsedMs: 3000, corrections: 1, estimatedUsd: 0.02, costComplete: true });
    store.feedback({ taskId: 'timeout', expectedRevision: linked.revision, outcome: 'success', category: 'general' });
    expect(store.report().summary).toMatchObject({ tasks: 1, success: 1, totalEstimatedUsd: 0.02, estimatedUsdPerSuccess: 0.02, costComplete: true });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('task grouping, explicit verification and aggregate cost retain failed attempts without double counting', async () => {
  const directory = await mkdtemp('/tmp/task-metrics-');
  const store = await openTaskMetrics(directory, () => 5000);
  try {
    store.observe(snapshot('first', { status: 'failed' }));
    store.observe(snapshot('fix', { startedAt: 3000, updatedAt: 4000 }));
    store.observe(snapshot('fix', { startedAt: 3000, updatedAt: 4000 }));
    expect(store.get('first').outcome).toBe('unverified');
    const linked = store.link({ taskId: 'first', runId: 'fix', kind: 'correction' });
    expect(linked).toMatchObject({ durationMs: 3000, corrections: 1, runCount: 2, estimatedUsd: 0.02 });
    expect(store.link({ taskId: 'first', runId: 'fix', kind: 'correction' })).toEqual(linked);
    store.feedback({ taskId: 'first', expectedRevision: linked.revision, outcome: 'success', category: 'calendar-change' });
    store.observe(snapshot('other', { status: 'failed' }));
    store.feedback({ taskId: 'other', expectedRevision: store.get('other').revision, outcome: 'failure', category: 'general' });
    expect(store.report().summary).toMatchObject({ tasks: 2, evaluated: 2, success: 1, verifiedSuccessRate: 0.5, totalEstimatedUsd: 0.03, estimatedUsdPerSuccess: 0.03 });
    store.observe(snapshot('fix', { startedAt: 3000, updatedAt: 4500, status: 'failed' }));
    expect(store.get('first').outcome).toBe('unverified');
    expect(() => store.feedback({ taskId: 'first', expectedRevision: linked.revision, outcome: 'success', category: 'general' })).toThrow('STALE');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('missing usage, pending approval and incomplete costs remain unknown across restart', async () => {
  const directory = await mkdtemp('/tmp/task-metrics-');
  let store = await openTaskMetrics(directory, () => 9000);
  try {
    store.observe(snapshot('pending', { status: 'waiting_approval', usage: null }));
    expect(store.get('pending')).toMatchObject({ endedAt: null, durationMs: null, elapsedMs: 8000, estimatedUsd: null, usageComplete: false });
    expect(() => store.feedback({ taskId: 'pending', expectedRevision: store.get('pending').revision, outcome: 'success', category: 'general' })).toThrow('PENDING');
    store.observe(snapshot('unknown', { usage: { calls: 1, inputTokens: 0, outputTokens: 0, usageComplete: false, estimatedUsd: null } }));
    store.close(); store = await openTaskMetrics(directory, () => 9000);
    expect(store.report().summary).toMatchObject({ tasks: 2, evaluated: 0, totalEstimatedUsd: null, estimatedUsdPerSuccess: null });
    store.observe(snapshot('pending', { updatedAt: 10000, status: 'completed' }));
    expect(store.get('pending').durationMs).toBe(9000);
    store.observe(snapshot('foreign', { sessionId: 'another-session' }));
    expect(() => store.link({ taskId: 'pending', runId: 'foreign', kind: 'correction' })).toThrow('LINK_INVALID');
    expect(() => store.feedback({ taskId: 'pending', expectedRevision: store.get('pending').revision, outcome: 'success', category: 'general', prompt: 'secret' })).toThrow();
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metrics refuses unsafe files and symlinks', async () => {
  const directory = await mkdtemp('/tmp/task-metrics-');
  try {
    const store = await openTaskMetrics(directory); store.close();
    await chmod(directory + '/task-metrics.sqlite', 0o644);
    await expect(openTaskMetrics(directory)).rejects.toThrow('UNSAFE');
    await symlink(directory, directory + '-link');
    await expect(openTaskMetrics(directory + '-link')).rejects.toThrow('UNSAFE');
  } finally { await rm(directory + '-link', { force: true }); await rm(directory, { recursive: true, force: true }); }
});

test('host automatically records durable usage and never treats completed output as verified success', async () => {
  const directory = await mkdtemp('/tmp/assistant-metrics-');
  const model = () => createMockLanguageModel({ streamEvents: [[
    { type: 'text-delta', textDelta: 'PRIVATE_OUTPUT_SENTINEL' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
  ]] });
  let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    const instance = model();
    host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: instance },
      taskMetricsPricing: { schemaVersion: 1, prices: [{ provider: instance.provider, model: instance.modelId,
        inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: 'synthetic-test',
        asOf: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }] } });
    const client = await connectAssistant(host.credentialsPath);
    const session = await client.command({ method: 'session.create', idempotencyKey: 'create' });
    if (!session.ok || session.data.kind !== 'session') throw new Error('SESSION_EXPECTED');
    const command = { method: 'run.start' as const, sessionId: session.data.session.sessionId,
      expectedRevision: session.data.session.revision, idempotencyKey: 'start', prompt: 'PRIVATE_PROMPT_SENTINEL' };
    const response = await client.command(command);
    expect(response.ok).toBe(true);
    await client.command(command);
    let report = await host.taskMetrics.report();
    expect(report.tasks).toHaveLength(1);
    const task = report.tasks[0]!;
    expect(task).toMatchObject({ outcome: 'unverified', runCount: 1, inputTokens: 100, outputTokens: 20, usageComplete: true, costComplete: true });
    expect(task.estimatedUsd).toBeCloseTo(0.00014, 8);
    expect(task.durationMs).not.toBeNull();
    await host.taskMetrics.feedback({ taskId: task.taskId, expectedRevision: task.revision, outcome: 'success', category: 'general' });
    await host.close(); host = undefined;
    host = await startAssistantHost({ directory, ownerId: 'owner', engine: { modelInstance: model() } });
    report = await host.taskMetrics.report();
    expect(report.summary).toMatchObject({ tasks: 1, success: 1 });
    const bytes = await readFile(directory + '/state/task-metrics.sqlite');
    expect(bytes.includes(Buffer.from('PRIVATE_PROMPT_SENTINEL'))).toBe(false);
    expect(bytes.includes(Buffer.from('PRIVATE_OUTPUT_SENTINEL'))).toBe(false);
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
