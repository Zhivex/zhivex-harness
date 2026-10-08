import { expect, test } from 'bun:test';
import { createMockLanguageModel, streamText, tool } from '@zhivex-ai/core';
import type { StreamEvent } from '@zhivex-ai/core';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import { z } from 'zod';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createTaskTelemetry } from '../src/runtime/task-telemetry.js';
import type { TaskTelemetrySnapshot } from '../src/runtime/task-telemetry.js';
import { createContextRuntime, SCOPED_CONTEXT_KEY } from '../src/runtime/context-runtime.js';
import { Workspace } from '../src/workspace/workspace.js';
import { createHarness, runHarnessTask } from '../src/runtime/harness.js';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createTextMessage, wrapLanguageModel } from '@zhivex-ai/core';

const context = () => ({ input: { messages: [] }, model: createMockLanguageModel() });

test('wall time remains distinct from overlapping operations; milestones are first observations', () => {
  let clock = 100;
  const telemetry = createTaskTelemetry({ now: () => clock, temperature: 'cold' });
  telemetry.mark('prepare-start');
  clock = 105; const first = telemetry.begin('tool');
  clock = 110; const second = telemetry.begin('tool');
  clock = 115; telemetry.observeEvent({ type: 'text-delta', textDelta: 'PRIVATE OUTPUT' });
  clock = 120; first(); first();
  clock = 125; second(); telemetry.mark('first-visible-text'); telemetry.finish();
  clock = 1000; telemetry.observeEvent({ type: 'text-delta', textDelta: 'later' });
  const snapshot = telemetry.snapshot();
  expect(snapshot).toMatchObject({ clock: 'monotonic', scope: 'invocation', temperature: 'cold', wallMs: 25,
    finished: true, activeSpans: 0, milestones: { 'prepare-start': 0, 'first-event': 15, 'first-text-event': 15, 'first-visible-text': 25 } });
  expect(snapshot.operationTotals.tool).toEqual({ count: 2, durationMs: 30, errors: 0, incomplete: 0 });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE OUTPUT');
  snapshot.operationTotals.tool.count = 100; snapshot.spans[0]!.durationMs = 100;
  expect(telemetry.snapshot().operationTotals.tool.count).toBe(2);
  expect(telemetry.snapshot().spans[0]!.durationMs).toBe(15);
});

test('numeric diagnostics stay bounded while totals include omitted spans', () => {
  let clock = 0;
  const telemetry = createTaskTelemetry({ now: () => clock++, maxSpans: 2 });
  for (let i = 0; i < 200; i++) telemetry.measure('persistence', () => i);
  expect(telemetry.snapshot()).toMatchObject({ omittedSpans: 198, activeSpans: 0, temperature: 'unknown' });
  expect(telemetry.snapshot().spans).toHaveLength(2);
  expect(telemetry.snapshot().operationTotals.persistence.count).toBe(200);
  for (const maxSpans of [-1, 1.2, Infinity, 4097]) expect(() => createTaskTelemetry({ maxSpans })).toThrow();
});

test('supplemental observer failures and clock anomalies cannot replace execution results', async () => {
  let clock = 10;
  const telemetry = createTaskTelemetry({ now: () => clock, observer: () => { throw new Error('PRIVATE OBSERVER ERROR'); } });
  expect(telemetry.measure('tool', () => 'ok')).toBe('ok');
  clock = 5; telemetry.mark('cancel-requested');
  clock = NaN; expect(telemetry.snapshot().wallMs).toBe(0);
  const rejected = createTaskTelemetry({ observer: async () => { throw new Error('PRIVATE ASYNC ERROR'); } });
  await rejected.measure('tool', async () => 'ok');
  await Promise.resolve();
  expect(rejected.snapshot().observerErrors).toBe(1);
  expect(telemetry.snapshot()).toMatchObject({ observerErrors: 2, clockErrors: 2 });
  expect(JSON.stringify(telemetry.snapshot())).not.toContain('PRIVATE');
  const stalled = createTaskTelemetry({ observer: () => new Promise<void>(() => {}) });
  expect(await stalled.measure('tool', async () => 'ok')).toBe('ok');
});

test('store proxy preserves sync behavior, method receivers, fencing, and mandatory persistence failures', async () => {
  const error = new Error('AUDIT_WRITE_REQUIRED');
  const target: AgentRunStore & { scope: string } = {
    scope: 'private', reconciliationFencing: true,
    load() { expect(this).toBe(target); return undefined; },
    checkpointBytes() { expect(this).toBe(target); return 42; },
    save() { expect(this).toBe(target); throw error; },
    async delete() { expect(this).toBe(target); throw error; }
  };
  const telemetry = createTaskTelemetry(), proxy = telemetry.store(target);
  expect(proxy.load('private-run')).toBeUndefined();
  expect(proxy.reconciliationFencing).toBe(true);
  expect(proxy.checkpointBytes!({} as Parameters<NonNullable<AgentRunStore['checkpointBytes']>>[0])).toBe(42);
  expect(() => proxy.save({} as Parameters<AgentRunStore['save']>[0])).toThrow(error);
  await expect(proxy.delete!('private-run')).rejects.toBe(error);
  expect(telemetry.snapshot().operationTotals.persistence).toMatchObject({ count: 4, errors: 2 });
  expect(JSON.stringify(telemetry.snapshot())).not.toContain('private-run');
});

for (const mode of ['generate', 'stream-open', 'stream-body'] as const) {
  test(`transport preserves original errors: ${mode}`, async () => {
    const telemetry = createTaskTelemetry(), error = new Error('PRIVATE TRANSPORT ERROR');
    const work = async () => {
      if (mode === 'generate') return telemetry.middleware.wrapGenerate!(context(), async () => { throw error; });
      const stream = await telemetry.middleware.wrapStream!(context(), async () => {
        if (mode === 'stream-open') throw error;
        return (async function* (): AsyncIterable<StreamEvent> { throw error; })();
      });
      for await (const _event of stream) { /* consume */ }
    };
    await expect(work()).rejects.toBe(error);
    expect(telemetry.snapshot()).toMatchObject({ activeSpans: 0, operationTotals: { model: { count: 1, errors: 1 } } });
    expect(JSON.stringify(telemetry.snapshot())).not.toContain('PRIVATE');
  });
}

test('stream timing covers consumption and records early iterator cancellation as incomplete', async () => {
  let clock = 0, returned = false;
  const telemetry = createTaskTelemetry({ now: () => clock });
  const events = (async function* (): AsyncIterable<StreamEvent> {
    try { clock = 10; yield { type: 'text-delta', textDelta: 'hidden' };
      clock = 20; yield { type: 'finish', finishReason: 'stop' }; }
    finally { returned = true; }
  })();
  const stream = await telemetry.middleware.wrapStream!(context(), async () => events);
  clock = 5;
  for await (const _event of stream) { clock = 15; break; }
  expect(returned).toBe(true);
  expect(telemetry.snapshot()).toMatchObject({ activeSpans: 0, milestones: { 'first-model-event': 10 },
    spans: [{ kind: 'model', durationMs: 15, outcome: 'incomplete' }] });
  expect(telemetry.snapshot().milestones['first-visible-text']).toBeUndefined();
});

test('terminal error event stays an error even if transport later emits finish', async () => {
  const telemetry = createTaskTelemetry();
  const error = new Error('transport');
  const stream = await telemetry.middleware.wrapStream!(context(), async () => (async function* (): AsyncIterable<StreamEvent> {
    yield { type: 'error', error }; yield { type: 'finish', finishReason: 'error' };
  })());
  const observed: StreamEvent[] = [];
  for await (const event of stream) observed.push(event);
  expect(observed[0]).toEqual({ type: 'error', error });
  expect(telemetry.snapshot().spans[0]!.outcome).toBe('error');
});

test('tool wrapper preserves permission metadata and installed SDK return values', async () => {
  const telemetry = createTaskTelemetry();
  let calls = 0;
  const tools = { read: tool({ name: 'read', schema: z.object({}), independent: true,
    requiresApproval: false, execute: async () => { calls++; return 'ok'; } }) };
  const wrapped = telemetry.tools(tools);
  expect(wrapped.read).toMatchObject({ independent: true, requiresApproval: false });
  const model = createMockLanguageModel({ streamEvents: [[
    { type: 'tool-call', toolCall: { id: '1', name: 'read', input: {} } }, { type: 'finish', finishReason: 'tool-calls' }
  ], [{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] });
  await streamText({ model, prompt: 'test', tools: wrapped, maxSteps: 2 }).collect();
  expect(calls).toBe(1);
  expect(telemetry.snapshot().operationTotals.tool).toMatchObject({ count: 1, errors: 0 });
});

test('cancellation request never implies settled cancellation or rendered text', () => {
  const telemetry = createTaskTelemetry();
  telemetry.mark('cancel-requested');
  telemetry.observeEvent({ type: 'text-delta', textDelta: '' });
  expect(telemetry.snapshot().milestones['first-text-event']).toBeUndefined();
  expect(telemetry.snapshot().milestones['cancel-settled']).toBeUndefined();
  telemetry.mark('cancel-settled'); telemetry.mark('render-start'); telemetry.mark('render-end');
  expect(telemetry.snapshot().milestones['cancel-settled']).toBeDefined();
});

test('compaction lane remains separate and bounded, and does not advance primary first-model-event', async () => {
  let clock = 0;
  const telemetry = createTaskTelemetry({ now: () => clock, maxSpans: 1 });
  const utility = telemetry.modelMiddleware('compaction');
  await utility.wrapGenerate!(context(), async () => { clock = 4; return { text: 'private summary' }; });
  const stream = await utility.wrapStream!(context(), async () => (async function* (): AsyncIterable<StreamEvent> {
    clock = 7; yield { type: 'text-delta', textDelta: 'private summary' };
    clock = 10; yield { type: 'finish', finishReason: 'stop' };
  })());
  for await (const _event of stream) { /* consume */ }
  expect(telemetry.snapshot().milestones['first-model-event']).toBeUndefined();
  clock = 12;
  await telemetry.modelMiddleware().wrapGenerate!(context(), async () => { clock = 15; return {}; });
  expect(telemetry.snapshot()).toMatchObject({ omittedSpans: 2, activeSpans: 0,
    operationTotals: { model: { count: 1, durationMs: 3 }, compaction: { count: 2, durationMs: 10 } } });
  expect(telemetry.snapshot().spans).toHaveLength(1);
  expect(JSON.stringify(telemetry.snapshot())).not.toContain('private summary');
});

test('request context measurement ends before model next begins, without counting transport twice', async () => {
  let clock = 0;
  const telemetry = createTaskTelemetry({ now: () => clock });
  const runtime = await createContextRuntime({ root: '/unused' } as Workspace, {}, false, {
    measurePreparation: work => telemetry.measure('context', async () => {
      clock = 5; await work(); clock = 10;
    })
  });
  const model = wrapLanguageModel(createMockLanguageModel({ responses: [{ text: 'done' }] }), [runtime.middleware, telemetry.middleware]);
  const original = context();
  await runtime.middleware.wrapGenerate!(original, () => telemetry.middleware.wrapGenerate!(original, async () => {
    expect(telemetry.snapshot().activeSpans).toBe(1);
    expect(telemetry.snapshot().operationTotals.context.count).toBe(1);
    clock = 30; return { text: 'done' };
  }));
  // Use the installed middleware composition as well; a request emits one span per lane.
  await model.generate({ messages: [] });
  const spans = telemetry.snapshot().spans;
  expect(spans.slice(0, 2)).toEqual([
    { kind: 'context', startMs: 0, durationMs: 10, outcome: 'completed' },
    { kind: 'model', startMs: 10, durationMs: 20, outcome: 'completed' }
  ]);
  expect(telemetry.snapshot().operationTotals.model.count).toBe(2);
  expect(telemetry.snapshot().operationTotals.context.count).toBe(2);
});

for (const method of ['wrapGenerate', 'wrapStream'] as const) {
  test(`scoped context read errors propagate before model transport: ${method}`, async () => {
    const root = await mkdtemp('/tmp/telemetry-context-read-');
    const telemetry = createTaskTelemetry();
    try {
      await mkdir(root + '/private'); await writeFile(root + '/private/AGENTS.md', Buffer.from([0]));
      const runtime = await createContextRuntime(await Workspace.open(root), {
        [SCOPED_CONTEXT_KEY]: { schemaVersion: 1, entries: [{ path: 'private/AGENTS.md', digest: null, bytes: 0 }] }
      }, true, { measurePreparation: work => telemetry.measure('context', work) });
      let dispatched = false;
      await expect(runtime.middleware[method]!(context(), async () => {
        dispatched = true; throw new Error('MODEL_MUST_NOT_START');
      })).rejects.toThrow('Scoped instructions must be UTF-8 text');
      expect(dispatched).toBe(false);
      expect(telemetry.snapshot()).toMatchObject({ activeSpans: 0,
        operationTotals: { context: { count: 1, errors: 1 }, model: { count: 0 } } });
      expect(JSON.stringify(telemetry.snapshot())).not.toContain('private');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('harness reports context initialization and preparation separately from semantic model compaction', async () => {
  const root = await mkdtemp('/tmp/telemetry-compaction-integration-');
  const primary = createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'done' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }]] });
  const utility = createMockLanguageModel({ responses: [{ text: 'Preserve compatibility.',
    usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } }] });
  let snapshot: TaskTelemetrySnapshot | undefined;
  const harness = await createHarness({ workspace: root, provider: 'openai', modelInstance: primary,
    compactionModel: 'small', compactionModelInstance: utility, store: createInMemoryAgentRunStore(),
    subagentProfiles: [], compactionMaxMessages: 4, compactionKeepRecentMessages: 2 });
  try {
    const result = await runHarnessTask(harness, { messages: [
      createTextMessage('user', 'Keep compatibility. ' + 'Old analysis. '.repeat(1500)),
      createTextMessage('assistant', 'Inspect existing schema. '.repeat(200)),
      createTextMessage('user', 'Proceed.'), createTextMessage('assistant', 'Inspect first.'), createTextMessage('user', 'Continue.')
    ] }, { onTaskTelemetry: value => { snapshot = value; } });
    expect(result.status).toBe('completed');
    expect(snapshot!.operationTotals).toMatchObject({ context: { count: 2 }, model: { count: 1 }, compaction: { count: 1 } });
    const modelSpan = snapshot!.spans.find(span => span.kind === 'model')!;
    for (const span of snapshot!.spans.filter(span => ['context', 'compaction'].includes(span.kind)))
      expect(span.startMs + span.durationMs).toBeLessThanOrEqual(modelSpan.startMs);
    expect(snapshot!.milestones['prepare-end']).toBeLessThanOrEqual(snapshot!.spans.find(span => span.kind === 'context')!.startMs);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
