import { decodeLosslessLines, type LosslessLines } from '../packages/core/src/context/lossless-lines.js';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { tool, wrapLanguageModel, type AgentRunState, type ModelMessage, type ToolSet } from '@zhivex-ai/core';
import { z } from 'zod';
import { createRequestContextTools, createRequestProjection, createResultIndex, canProjectToolResults } from '../packages/core/src/context/request-projection.js';
import { createAdaptiveCompaction, estimateMessages } from '../packages/core/src/context/adaptive-compaction.js';
import { createHarness, runHarness } from '../packages/core/src/runtime/harness.js';
import { createContextRuntime, SCOPED_CONTEXT_KEY } from '../packages/core/src/runtime/context-runtime.js';
import { applyHarnessToolPolicy } from '../packages/core/src/runtime/tool-policy.js';
import { Workspace } from '../packages/core/src/workspace/workspace.js';

const result = (name: string, id: string) => ({ toolName: name, toolCallId: id,
  output: { path: `${id}.ts`, digest: 'sha256:' + 'a'.repeat(64), content: 'start\n' + Array.from({length:100}, (_, i) => `${i}:` + 'x'.repeat(100)).join('\n') + '\nMIDDLE_REQUIRED\n' + Array.from({length:100}, (_, i) => `${i}:` + 'y'.repeat(100)).join('\n') + '\nend' }, isError: false });
const exchange = (r: ReturnType<typeof result>): ModelMessage[] => [
  { role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: r.toolCallId, name: r.toolName, input: {} } }] },
  { role: 'tool', parts: [{ type: 'tool-result', toolResult: r }] }
];
const snapshot = (results: ReturnType<typeof result>[], revision = 1, runId = 'run') =>
  ({ runId, revision, toolResults: results } as unknown as AgentRunState);
const catalogFor = (load: (id: string) => Promise<AgentRunState | undefined>) => {
  let catalog: ToolSet = Object.fromEntries(['read_file', 'read_files', 'run_check'].map(name => [name,
    tool({ name, schema: z.object({}), execute: () => null })]));
  catalog = { ...catalog, ...createRequestContextTools(() => catalog, load) };
  return catalog;
};

for (const mode of ['generate', 'stream'] as const) test(`old file results shrink losslessly; newest parallel reads stay complete (${mode})`, async () => {
  const old = result('read_files', 'old'), fresh = result('read_file', 'fresh'), parallel = result('read_file', 'parallel');
  const state = snapshot([old, fresh, parallel]);
  const messages = [...exchange(old), ...exchange(fresh)];
  messages.at(-2)!.parts.push({ type: 'tool-call', toolCall: { id: parallel.toolCallId, name: parallel.toolName, input: {} } });
  messages.at(-1)!.parts.push({ type: 'tool-result', toolResult: parallel });
  const original = structuredClone(messages);
  let captured: ModelMessage[] = [];
  const base = createMockLanguageModel();
  base.generate = async input => { captured = input.messages; return { text: 'ok', finishReason: 'stop' }; };
  base.stream = async input => { captured = input.messages; return (async function* () { yield { type: 'finish' as const, finishReason: 'stop' as const }; })(); };
  const catalog = catalogFor(async id => id === 'run' ? state : undefined);
  const projection = createRequestProjection(async () => state);
  const wrapped = wrapLanguageModel(base, [projection]);
  if (mode === 'generate') await wrapped.generate({ messages, tools: catalog });
  else for await (const _ of await wrapped.stream!({ messages, tools: catalog })) {}
  expect(messages).toEqual(original); expect(state.toolResults[0]).toEqual(old);
  expect(captured.at(-1)).toEqual(original.at(-1));
  const projected = captured[1]!.parts[0];
  if (projected?.type !== 'tool-result') throw new Error('missing result');
  const ref = { resultId: 'sha256:' + createHash('sha256').update(JSON.stringify([old.toolName, old.output])).digest('hex') };
  expect(JSON.stringify(projected)).toContain('MIDDLE_REQUIRED');
  expect(decodeLosslessLines((projected.toolResult.output as unknown as {content: LosslessLines}).content)).toBe(old.output.content);
  const reader = catalog.read_tool_result!; if (!('execute' in reader)) throw new Error('reader');
  let offset: number | null = 0, recovered = '';
  while (offset !== null) {
    const page = await reader.execute({ resultId: ref.resultId, offset }, { runId: 'run' } as never) as { content: string; nextOffset: number | null };
    recovered += page.content; offset = page.nextOffset;
  }
  expect(JSON.parse(recovered)).toEqual(old.output);
  await expect(reader.execute({ resultId: ref.resultId, offset: 0 }, { runId: 'other' } as never)).rejects.toThrow('CONTEXT_RESULT_UNAVAILABLE');
  expect(projection.measureMessages(messages)).toEqual(captured);
  const config = { maxMessages: 60, maxEstimatedInputTokens: 40000, keepRecentMessages: 12 };
  expect(createAdaptiveCompaction(config, { projectMessages: projection.measureMessages }).estimateTokens!(messages)).toBe(estimateMessages(captured));
  expect(estimateMessages(captured)).toBeLessThan(estimateMessages(messages));
});

test('index is revision and scope bound, invalidates deletion and checks current catalog', async () => {
  const r = result('read_file', 'old'), state = snapshot([r]);
  const index = createResultIndex();
  const first = index(state, { tenantId: 'one' });
  expect(index(structuredClone(state), { tenantId: 'one' })).toBe(first);
  expect(index(state, { tenantId: 'two' })).not.toBe(first);
  expect(index(snapshot([], 2))).toHaveLength(0);
  expect(index(undefined)).toHaveLength(0);
  let current: AgentRunState | undefined = state;
  const catalog = catalogFor(async () => current);
  const reader = catalog.read_tool_result!; if (!('execute' in reader)) throw new Error('reader');
  const id = 'sha256:' + createHash('sha256').update(JSON.stringify([r.toolName, r.output])).digest('hex');
  const read = () => reader.execute({ resultId: id, offset: 0 }, { runId: 'run' } as never);
  await read();
  current = snapshot([], 2);
  await expect(read()).rejects.toThrow('CONTEXT_RESULT_UNAVAILABLE');
  current = state; delete catalog.read_file;
  await expect(read()).rejects.toThrow('CONTEXT_RESULT_UNAVAILABLE');
});

test('no store read without eligible results; missing durable evidence and errors remain complete', async () => {
  let loads = 0;
  const projection = createRequestProjection(async () => { loads++; return undefined; });
  const base = createMockLanguageModel(); let received: ModelMessage[] = [];
  base.generate = async input => { received = input.messages; return { text: 'ok', finishReason: 'stop' }; };
  const model = wrapLanguageModel(base, [projection]);
  const tools = catalogFor(async () => undefined);
  const old = result('read_file', 'old');
  await model.generate({ messages: exchange(old), tools });
  expect(loads).toBe(0);
  const messages = [...exchange(old), ...exchange(result('read_file', 'new'))];
  await model.generate({ messages, tools });
  expect(loads).toBe(1); expect(received).toEqual(messages);
  old.isError = true;
  await model.generate({ messages: [...exchange(old), ...exchange(result('read_file', 'new'))], tools });
  expect(loads).toBe(1);
});

test('failed persistence never makes content eligible for compaction projection', async () => {
  const projection = createRequestProjection(async () => undefined);
  const original = createInMemoryAgentRunStore();
  original.save = async () => { throw new Error('failed save'); };
  const state = snapshot([result('run_check', 'check')]);
  await expect(projection.store(original, 'run').save(state)).rejects.toThrow('failed save');
  expect(projection.measureMessages(exchange(state.toolResults[0] as ReturnType<typeof result>)))
    .toEqual(exchange(state.toolResults[0] as ReturnType<typeof result>));
});

test('installed SDK estimates projected history before compaction and retains original evidence', async () => {
  const root = await mkdtemp('/tmp/context-projected-sdk-');
  let step = 0; const requests: ModelMessage[][] = [];
  const base = createMockLanguageModel();
  base.stream = async input => {
    requests.push(structuredClone(input.messages)); const current = step++;
    return (async function* () {
      if (current < 4) yield { type: 'tool-call' as const, toolCall: { id: `r${current}`, name: 'read_file', input: { path: `${current}.txt` } } };
      else yield { type: 'text-delta' as const, textDelta: 'done' };
      yield { type: 'finish' as const, finishReason: current < 4 ? 'tool-calls' as const : 'stop' as const };
    })();
  };
  const harness = await createHarness({ workspace: root, provider: 'openai', modelInstance: base,
    store: createInMemoryAgentRunStore(), toolNames: ['read_file', 'discover_tools', 'read_tool_result'],
    subagentProfiles: [], projectContext: false, unlimitedTokens: true, compactionMaxEstimatedInputTokens: 12000 });
  try {
    for (let i = 0; i < 4; i++) await writeFile(`${root}/${i}.txt`, Array.from({length:100}, (_, n) => `${i}:${n}:` + 'x'.repeat(150)).join('\n'));
    const output = await runHarness(harness, { prompt: 'Inspect all four files.' });
    expect(output.status).toBe('completed');
    expect(output.state.compactions ?? []).toHaveLength(0);
    expect(output.state.toolResults).toHaveLength(4);
    expect(JSON.stringify(output.state.toolResults)).toContain('x'.repeat(150));
    expect(JSON.stringify(requests.at(-1))).toContain('line-suffix-v1');
    expect(estimateMessages(output.state.messages)).toBeGreaterThan(12000);
    expect(estimateMessages(requests.at(-1)!)).toBeLessThan(12000);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test('scoped refresh remains fresh after batching and rejects replacement before dispatch', async () => {
  const root = await mkdtemp('/tmp/context-scoped-batch-');
  try {
    await mkdir(`${root}/src`); await writeFile(`${root}/src/AGENTS.md`, 'old');
    const workspace = await Workspace.open(root);
    const runtime = await createContextRuntime(workspace, {}, true);
    const tools = runtime.wrapTools({ read_file: tool({ name: 'read_file', schema: z.object({ path: z.string() }), execute: input => ({ path: input.path }) }) });
    const reader = tools.read_file!; if (!('execute' in reader)) throw new Error('reader');
    const metadata: Record<string, unknown> = {};
    await Promise.all([1, 2, 3, 4].map(i => reader.execute({ path: `src/${i}.ts` }, { metadata } as never)));
    expect(metadata[SCOPED_CONTEXT_KEY]).toBeDefined();
    await writeFile(`${root}/src/AGENTS.md`, 'fresh before request');
    let calls = 0; let text = '';
    const base = createMockLanguageModel();
    base.generate = async input => { calls++; text = JSON.stringify(input.messages); return { text: 'ok', finishReason: 'stop' }; };
    const model = wrapLanguageModel(base, [runtime.middleware]);
    await model.generate({ messages: [] }); expect(text).toContain('fresh before request');
    await rm(`${root}/src/AGENTS.md`); await writeFile(`${root}/target`, 'unsafe');
    await symlink(`${root}/target`, `${root}/src/AGENTS.md`);
    await expect(model.generate({ messages: [] })).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file references survive approval and reopening as untrusted historical evidence', async () => {
  const root = await mkdtemp('/tmp/context-file-reopen-');
  let step = 0, reference = '';
  const base = createMockLanguageModel();
  base.stream = async input => {
    const current = step++;
    if (current === 2) {
      for (const message of input.messages) for (const part of message.parts) {
        if (part.type === 'tool-result' && part.toolResult.toolCallId === 'old') reference = 'sha256:' + createHash('sha256').update(JSON.stringify([part.toolResult.toolName, part.toolResult.output])).digest('hex');
      }
      expect(reference).toMatch(/^sha256:/);
    }
    return (async function* () {
      if (current < 2) yield { type: 'tool-call' as const, toolCall: { id: current ? 'new' : 'old', name: 'read_file', input: { path: current ? 'new.txt' : 'old.txt' } } };
      else if (current === 2) yield { type: 'tool-call' as const, toolCall: { id: 'recover', name: 'read_tool_result', input: { resultId: reference, offset: 9000 } } };
      else yield { type: 'text-delta' as const, textDelta: 'recovered' };
      yield { type: 'finish' as const, finishReason: current < 3 ? 'tool-calls' as const : 'stop' as const };
    })();
  };
  const options = { workspace: root, provider: 'openai', modelInstance: base, projectContext: false, subagentProfiles: [] as [],
    toolPolicy: { schemaVersion: 1 as const, rules: [{ id: 'review-page', tools: ['read_tool_result'], decision: 'ask_user' as const, reason: 'host review' }] } };
  let harness = await createHarness(options);
  try {
    await writeFile(`${root}/old.txt`, 'x'.repeat(10000) + 'MIDDLE_REQUIRED' + 'y'.repeat(4000));
    await writeFile(`${root}/new.txt`, 'new');
    const waiting = await runHarness(harness, { prompt: 'Read files and retrieve the middle.' });
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.state.pendingApprovals[0]?.name).toBe('read_tool_result');
    await harness.close(); harness = await createHarness(options);
    const saved = await harness.store.load(waiting.state.runId, waiting.state.scope);
    expect(saved).toBeDefined();
    const done = await runHarness(harness, { state: saved!, approvals: saved!.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
    expect(done.status).toBe('completed');
    const recovered = done.state.toolResults.find(r => r.toolCallId === 'recover');
    expect(recovered?.isError).not.toBe(true); expect(JSON.stringify(recovered?.output)).toContain('MIDDLE_REQUIRED');
    // Projection/retrieval cannot issue a model edit reference: the original
    // authenticated read remains necessary, as covered by model-edit-reference tests.
    expect((recovered?.output as { source: string }).source).toBe('untrusted-tool-result');
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});


test('denied result recovery preserves full context instead of advertising inaccessible excerpts', async () => {
  const old = result('read_file', 'old'), fresh = result('read_file', 'fresh');
  const state = snapshot([old, fresh]); const messages = [...exchange(old), ...exchange(fresh)];
  const tools = applyHarnessToolPolicy(catalogFor(async () => state), { schemaVersion: 1,
    rules: [{ id: 'deny-recovery', tools: ['read_tool_result'], decision: 'deny', reason: 'host restriction' }] });
  expect(canProjectToolResults(tools)).toBe(false);
  const base = createMockLanguageModel(); let received: ModelMessage[] = [];
  base.generate = async input => { received = input.messages; return { text: 'ok', finishReason: 'stop' }; };
  await wrapLanguageModel(base, [createRequestProjection(async () => state)]).generate({ messages, tools });
  expect(received).toEqual(messages);
});

test('a changed result in a later revision cannot inherit a cached digest', () => {
  const original = result('read_file', 'file');
  const index = createResultIndex(); const first = index(snapshot([original]));
  const oldId = [...first.keys()][0]!;
  const changed = structuredClone(original); changed.output.content = 'replacement';
  const next = index(snapshot([changed], 2));
  expect(next.has(oldId)).toBe(false);
  expect([...next.values()][0]!.text).toContain('replacement');
});

test('historical recovery queries return bounded evidence and explicit misses', async () => {
  const r = result('run_check', 'query'), state = snapshot([r]);
  const catalog = catalogFor(async () => state);
  const reader = catalog.read_tool_result!; if (!('execute' in reader)) throw new Error('reader');
  const resultId = 'sha256:' + createHash('sha256').update(JSON.stringify([r.toolName, r.output])).digest('hex');
  const hit = await reader.execute({resultId, offset:0, query:'MIDDLE_REQUIRED', length:100}, {runId:'run'} as never) as any;
  expect(hit.found).toBe(true); expect(hit.content).toContain('MIDDLE_REQUIRED');
  expect(hit.content.length).toBeLessThanOrEqual(100); expect(hit.source).toBe('untrusted-tool-result');
  const miss = await reader.execute({resultId, offset:0, query:'absent-sentinel', length:16000}, {runId:'run'} as never) as any;
  expect(miss.found).toBe(false); expect(miss.content).toBe(''); expect(miss.nextOffset).toBeNull();
});

test('mixed batched reads preserve both encoded and incompressible files exactly', () => {
  const r = result('read_files','batch');
  const original = {files:[r.output, {path:'random.txt', content:'z'.repeat(9000)}]};
  const batch = {...r, output:original};
  const fresh=result('read_file','new');
  const projection=createRequestProjection(async()=>undefined);
  projection.observe(snapshot([batch as unknown as ReturnType<typeof result>,fresh]));
  const projected=projection.measureMessages([...exchange(batch as unknown as ReturnType<typeof result>),...exchange(fresh)]);
  const part=projected[1]!.parts[0]!; if(part.type!=='tool-result')throw new Error('result');
  const files=(part.toolResult.output as any).files;
  expect(decodeLosslessLines(files[0].content)).toBe(original.files[0]!.content);
  expect(files[1]).toEqual(original.files[1]);
  expect(batch.output).toEqual(original);
});
