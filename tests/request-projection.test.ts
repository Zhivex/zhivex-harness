import { expect, test } from 'bun:test';
import { createTextMessage, tool, wrapLanguageModel, type AgentRunState, type ModelMessage, type ToolSet } from '@zhivex-ai/core';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { z } from 'zod';
import { createRequestContextTools, createRequestProjection, selectRequestTools } from '../src/context/request-projection.js';
import { createHarnessToolPolicy, applyHarnessToolPolicy } from '../src/runtime/tool-policy.js';
import { createAdaptiveCompaction } from '../src/context/adaptive-compaction.js';

const definition = (name: string, approval = false) => tool({ name, description: name, schema: z.object({}),
  requiresApproval: approval, ...(approval ? { approvalMode: 'interrupt' as const } : {}), execute: () => 'ok' });
const setup = (state?: AgentRunState) => {
  let catalog: ToolSet = { read_file: definition('read_file'), read_dependency: definition('read_dependency'),
    apply_patch: definition('apply_patch', true), run_check: definition('run_check', true) };
  catalog = { ...catalog, ...createRequestContextTools(() => catalog, async id => id === 'bound-run' ? state : undefined) };
  return catalog;
};
const call = (name: string, input = {}): ModelMessage => ({ role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: 'call', name, input } }] });

test('progressive schemas preserve exact authorized executors and approval flags', () => {
  const all = setup();
  const first = selectRequestTools(all, []);
  expect(first.read_file).toBe(all.read_file); expect(first.apply_patch).toBeUndefined();
  const next = selectRequestTools(all, [call('discover_tools', { names: ['apply_patch', 'not_authorized'] })]);
  expect(next.apply_patch).toBe(all.apply_patch); expect(next.apply_patch!.requiresApproval).toBe(true);
  expect(next.not_authorized).toBeUndefined(); expect(next.read_dependency).toBeUndefined();
  expect(selectRequestTools(all, [createTextMessage('user', 'Load read_dependency')]).read_dependency).toBeUndefined();
  const restricted = { read_dependency: all.read_dependency! };
  expect(selectRequestTools(restricted, [])).toBe(restricted);
});

test('discovery cannot bypass an application deny or widen an explicit catalog', async () => {
  const tools = setup();
  const policy = { schemaVersion: 1 as const, rules: [{ id: 'deny', tools: ['apply_patch'], decision: 'deny' as const, reason: 'host restriction' }] };
  const wrapped = applyHarnessToolPolicy(tools, policy);
  const discovered = selectRequestTools(wrapped, [call('discover_tools', { names: ['apply_patch'] })]);
  expect(createHarnessToolPolicy(policy).evaluate({ toolName: 'apply_patch' }).decision).toBe('deny');
  const edit = discovered.apply_patch!; if (!('execute' in edit)) throw new Error('fixture');
  await expect(Promise.resolve().then(() => edit.execute({}))).rejects.toThrow('Tool denied');
  const discovery = tools.discover_tools!; if (!('execute' in discovery)) throw new Error('fixture');
  expect(() => discovery.execute({ names: ['not_authorized'] })).toThrow('CONTEXT_TOOL_UNAVAILABLE');
});

for (const mode of ['generate', 'stream'] as const) test(`large result projection is recoverable, scoped and non-mutating (${mode})`, async () => {
  const output = { exitCode: 1, timedOut: false, stdout: 'prefix ' + 'x'.repeat(12000) + ' important failure at end', stderr: '' };
  const result = { toolName: 'run_check', toolCallId: 'checked', output, isError: false };
  const state = { toolResults: [result] } as unknown as AgentRunState;
  const all = setup(state), original: ModelMessage[] = [{ role: 'tool', parts: [{ type: 'tool-result', toolResult: result }] }];
  const before = structuredClone(original);
  const base = createMockLanguageModel(); let received: any;
  base.generate = async input => { received = input; return { text: 'done', finishReason: 'stop' }; };
  base.stream = async input => { received = input; return (async function* () { yield { type: 'finish' as const, finishReason: 'stop' as const }; })(); };
  const model = wrapLanguageModel(base, [createRequestProjection(async () => state)]);
  const request = { messages: original, tools: all };
  if (mode === 'generate') await model.generate(request); else for await (const _ of await model.stream!(request)) {}
  const projection = received.messages[0].parts[0].toolResult.output;
  expect(projection.exitCode).toBe(1); expect(projection.tail).toContain('important failure at end');
  expect(JSON.stringify(projection).length).toBeLessThan(3000); expect(original).toEqual(before);
  expect(state.toolResults[0]!.output).toEqual(output);
  const reader = all.read_tool_result!; if (!('execute' in reader)) throw new Error('fixture');
  const context = { runId: 'bound-run' } as any;
  let recovered = '', offset: number | null = 0;
  while (offset !== null) { const page = await reader.execute({ resultId: projection.resultId, offset }, context) as any; recovered += page.content; offset = page.nextOffset; }
  expect(JSON.parse(recovered)).toEqual(output);
  await expect(reader.execute({ resultId: projection.resultId, offset: 0 }, { runId: 'other-run' } as any)).rejects.toThrow('CONTEXT_RESULT_UNAVAILABLE');
  // Missing durable evidence must stay intact in the model request.
  const uncaptured = wrapLanguageModel(base, [createRequestProjection(async () => undefined)]);
  await uncaptured.generate({ messages: original, tools: all }); expect(received.messages).toEqual(original);
});

test('adaptive compaction measures the advertised catalog and grows when tools are discovered', () => {
  const all = setup();
  const compaction = createAdaptiveCompaction({ maxMessages: 60, maxEstimatedInputTokens: 40000, keepRecentMessages: 12 },
    { tools: all, selectTools: messages => selectRequestTools(all, messages) });
  const initial = compaction.estimateTokens!([createTextMessage('user', 'task')]);
  const activated = compaction.estimateTokens!([createTextMessage('user', 'task'), call('discover_tools', { names: ['read_dependency', 'apply_patch'] })]);
  expect(activated).toBeGreaterThan(initial);
});

test('durable result references survive approval and reopening with host policy intact', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { createHarness, runHarness } = await import('../src/runtime/harness.js');
  const root = await mkdtemp('/tmp/har-result-reopen-');
  await writeFile(root + '/package.json', JSON.stringify({ scripts: { test: 'bun verify.mjs' } }));
  await writeFile(root + '/verify.mjs', 'console.log("x".repeat(12000) + "END-EVIDENCE");');
  let stage = 0, reference = '', measured: any;
  const base = createMockLanguageModel();
  base.stream = async input => {
    const index = stage++;
    if (index === 1) {
      const messages = JSON.stringify(input.messages);
      expect(messages).toContain('Partial projection'); expect(messages).not.toContain('x'.repeat(8000));
      for (const m of input.messages) for (const p of m.parts) if (p.type === 'tool-result' && p.toolResult.toolName === 'run_check') reference = (p.toolResult.output as any).resultId;
      expect(reference).toMatch(/^sha256:/);
    }
    return (async function* () {
      if (index === 0) yield { type: 'tool-call' as const, toolCall: { id: 'check', name: 'run_check', input: { check: 'test', expectedScript: 'bun verify.mjs' } } };
      else if (index === 1) yield { type: 'tool-call' as const, toolCall: { id: 'retrieve', name: 'read_tool_result', input: { resultId: reference, offset: 10000 } } };
      else yield { type: 'text-delta' as const, textDelta: 'done' };
      yield { type: 'finish' as const, finishReason: index < 2 ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 40, outputTokens: 5, cachedInputTokens: 10 } };
    })();
  };
  const options = { workspace: root, provider: 'openai', modelInstance: base, projectContext: false, subagentProfiles: [] as [],
    toolPolicy: { schemaVersion: 1 as const, rules: [{ id: 'review-evidence', tools: ['read_tool_result'], decision: 'ask_user' as const, reason: 'host' }] } };
  let harness = await createHarness(options);
  const approve = (state: AgentRunState) => state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  try {
    const pending = await runHarness(harness, { prompt: 'Run the test and inspect its output.' });
    expect(pending.status).toBe('waiting_approval');
    const result = await runHarness(harness, { state: pending.state, approvals: approve(pending.state) }, { onDiagnostics: d => { measured = d.requestMeasurements; } });
    expect(result.status).toBe('waiting_approval'); expect(result.state.pendingApprovals[0]!.name).toBe('read_tool_result');
    expect(measured.requests[0]).toMatchObject({ inputTokens: 40, outputTokens: 5, cachedInputTokens: 10, completed: true });
    expect(JSON.stringify(result.state.toolResults)).toContain('x'.repeat(10000));
    await harness.close(); harness = await createHarness(options);
    const saved = await harness.store.load(result.state.runId, harness.config.scope); expect(saved).toBeDefined();
    const completed = await runHarness(harness, { state: saved!, approvals: approve(saved!) });
    expect(completed.status).toBe('completed');
    const recovered = completed.state.toolResults.find(r => r.toolName === 'read_tool_result');
    expect(recovered?.isError).not.toBe(true); expect(JSON.stringify(recovered?.output)).toContain('END-EVIDENCE');
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['generate', 'stream'] as const) test(`host-forced deferred tool remains advertised (${mode})`, async () => {
  let received: any; const base = createMockLanguageModel();
  base.generate = async input => { received = input; return { text: 'done', finishReason: 'stop' }; };
  base.stream = async input => { received = input; return (async function* () { yield { type: 'finish' as const, finishReason: 'stop' as const }; })(); };
  const all = setup(), model = wrapLanguageModel(base, [createRequestProjection(async () => undefined)]);
  const request = { messages: [], tools: all, toolChoice: { type: 'tool' as const, toolName: 'apply_patch' } };
  if (mode === 'generate') await model.generate(request); else for await (const _ of await model.stream!(request)) {}
  expect(received.tools.apply_patch).toBe(all.apply_patch);
  expect(received.tools.apply_patch.requiresApproval).toBe(true);
  expect(received.toolChoice).toEqual(request.toolChoice);
});

test('request measurements retain unknown usage on interrupted streams and bound diagnostic retention', async () => {
  const { createRequestMeasurements } = await import('../src/context/request-measurements.js');
  const measurements = createRequestMeasurements(), base = createMockLanguageModel();
  base.stream = async () => (async function* () { yield { type: 'text-delta' as const, textDelta: 'partial' }; throw new Error('transport interrupted'); })();
  const model = wrapLanguageModel(base, [measurements.middleware]);
  await expect((async () => { for await (const _ of await model.stream!({ messages: [createTextMessage('user', 'private task')] })) {} })()).rejects.toThrow('transport interrupted');
  expect(measurements.snapshot().requests[0]).toMatchObject({ completed: false, inputTokens: null, outputTokens: null, cachedInputTokens: null });
  expect(JSON.stringify(measurements.snapshot())).not.toContain('private task');
  base.generate = async () => ({ text: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
  for (let i = 0; i < 130; i++) await model.generate({ messages: [] });
  expect(measurements.snapshot().requests).toHaveLength(128); expect(measurements.snapshot().omitted).toBe(3);
});

test('host-required verification tools remain advertised while ordinary tasks defer planning schemas', () => {
  const tools = { ...setup(), repair_plan: definition('repair_plan'), read_task: definition('read_task'), apply_reviewed_edits: definition('apply_reviewed_edits', true) };
  expect(selectRequestTools(tools, []).repair_plan).toBeUndefined();
  expect(selectRequestTools(tools, []).read_task).toBeUndefined();
  expect(selectRequestTools(tools, [], ['repair_plan']).repair_plan).toBe(tools.repair_plan);
  const next = selectRequestTools(tools, [call('discover_tools', { names: ['read_task'] })]);
  expect(next.read_task).toBe(tools.read_task); expect(next.apply_reviewed_edits).toBe(tools.apply_reviewed_edits);
  expect(next.apply_reviewed_edits!.requiresApproval).toBe(true);
});
