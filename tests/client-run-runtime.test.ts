import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness } from '../src/runtime/harness.js';
import { createHarnessClientAdapter, type HarnessClientRunRuntimeOptions } from '../src/client/adapter.js';
import { inspectHarnessPolicy } from '../src/runtime/policy-inspection.js';

async function fixture(run: (c: { harness: Awaited<ReturnType<typeof createHarness>>; connect: (prepareRun: NonNullable<HarnessClientRunRuntimeOptions['prepareRun']>) => Promise<any> }) => Promise<void>) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'client-run-runtime-'));
  await writeFile(path.join(workspace, 'a.txt'), 'before\n');
  const harness = await createHarness({ workspace, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: [[
    { type: 'tool-call', toolCall: { id: 'edit', name: 'apply_reviewed_replacement', input: { path: 'a.txt',
      expectedDigest: `sha256:${createHash('sha256').update('before\n').digest('hex')}`, oldText: 'before', newText: 'after' } } },
    { type: 'finish', finishReason: 'tool-calls' }
  ], [{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  const adapters: Awaited<ReturnType<typeof createHarnessClientAdapter>>[] = [];
  try { await run({ harness, async connect(prepareRun) {
    const adapter = await createHarnessClientAdapter(harness, { prepareRun }); adapters.push(adapter);
    const hello = adapter.negotiate([1]); if (!hello.ok) throw new Error('negotiation');
    let seq = 0;
    const call = (command: any) => adapter.dispatch({ protocolVersion: 1, requestId: String(++seq), connectionId: hello.connectionId,
      command: { ...command, projectId: hello.projectId } });
    const response = await call({ method: 'session.create', idempotencyKey: 'create' });
    if (!response.ok || response.data.kind !== 'session') throw new Error('session');
    const session = response.data.session;
    return { adapter, call, session, start: (key = 'start') => call({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, prompt: 'edit', idempotencyKey: key }) };
  } }); } finally { for (const adapter of adapters) adapter.close(); await harness.close(); await rm(workspace, { recursive: true, force: true }); }
}

test('host prepares and releases each invocation including approval pause and resume', async () => fixture(async ({ harness, connect }) => {
  const contexts: { runId: string; sessionId: string; resuming: boolean }[] = []; let released = 0;
  const f = await connect(async context => { contexts.push(context); return { harness, release: async () => { released++; } }; });
  const waiting = await f.start(); expect(waiting.ok).toBe(true); expect(waiting.data.run.status).toBe('waiting_approval'); expect(released).toBe(1);
  const result = await f.call({ method: 'approval.resolve', sessionId: f.session.sessionId, runId: waiting.data.run.runId,
    expectedRevision: waiting.data.run.revision, idempotencyKey: 'approval', decisions: waiting.data.run.approvals.map((a: any) => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) });
  expect(result.ok).toBe(true); expect(result.data.run.status).toBe('completed'); expect(released).toBe(2);
  expect(contexts.map(c => c.resuming)).toEqual([false, true]); expect(contexts[0]?.runId).toBe(contexts[1]?.runId);
}));

test('denied preparation records a terminal run and leaves session reads usable', async () => fixture(async ({ harness, connect }) => {
  let attempts = 0;
  const f = await connect(async () => { attempts++; throw new Error('PRIVATE_HOST_DENIAL'); });
  expect(await f.start()).toMatchObject({ ok: false, error: { code: 'EXECUTION_FAILED' } });
  const session = await f.call({ method: 'session.get', sessionId: f.session.sessionId });
  expect(session.ok).toBe(true); expect(session.data.session.runs[0].status).toBe('failed');
  const row = await harness.store.load(session.data.session.runs[0].runId, harness.config.scope);
  expect(row?.steps).toEqual([]); expect(JSON.stringify(row)).not.toContain('PRIVATE_HOST_DENIAL');
  expect(await f.call({ method: 'run.start', sessionId: f.session.sessionId, expectedRevision: session.data.session.revision,
    prompt: 'try another request', idempotencyKey: 'new-prompt' })).toMatchObject({ ok: false, error: { code: 'EXECUTION_FAILED' } });
  expect(attempts).toBe(2);
}));

test('cancellation during preparation aborts before model execution and releases returned runtime', async () => fixture(async ({ harness, connect }) => {
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let released = 0;
  const f = await connect(async ({ signal }) => {
    ready(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { harness, release: async () => { released++; } };
  });
  const pending = f.start(); await started; await f.adapter.cancelActive(); await pending;
  const session = await f.call({ method: 'session.get', sessionId: f.session.sessionId });
  expect(session.data.session.runs[0].status).toBe('cancelled'); expect(released).toBe(1);
  expect((await harness.store.load(session.data.session.runs[0].runId, harness.config.scope))?.steps).toEqual([]);
}));

test('prepared runtime cannot replace the durable store and is released on rejection', async () => fixture(async ({ harness, connect }) => {
  let released = 0;
  const f = await connect(async () => ({ harness: { ...harness, store: createInMemoryAgentRunStore() }, release: async () => { released++; } }));
  expect(await f.start()).toMatchObject({ ok: false, error: { code: 'EXECUTION_FAILED' } }); expect(released).toBe(1);
}));

test('policy query tracks the prepared runtime while active and decision evidence belongs to that runtime', async () => fixture(async ({ harness, connect }) => {
  let ready!: () => void, proceed!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  const model = createMockLanguageModel({ streamEvents: [[
    { type: 'tool-call', toolCall: { id: 'read', name: 'read_file', input: { path: 'a.txt' } } },
    { type: 'finish', finishReason: 'tool-calls' }
  ], [{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] });
  const stream = model.stream!.bind(model);
  model.stream = async (...args) => { ready(); await gate; return stream(...args); };
  const prepared = await createHarness({ workspace: harness.workspace.root, store: harness.store, subagentProfiles: [], modelInstance: model,
    toolPolicy: { schemaVersion: 1, rules: [{ id: 'prepared-read', tools: ['read_file'], decision: 'allow', reason: 'Prepared host rule' }] } });
  let released = 0;
  const f = await connect(async () => ({ harness: prepared, release: async () => { released++; } }));
  let pending: Promise<any> | undefined;
  try {
    expect((await f.call({ method: 'policy.get' })).data.policy).toEqual(inspectHarnessPolicy(harness));
    pending = f.start(); await entered;
    const queried = await f.call({ method: 'policy.get' });
    expect(queried.ok).toBe(true);
    expect(queried.data.policy).toEqual(inspectHarnessPolicy(prepared));
    proceed(); const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data.run.cliResult.policyEvidence.events).toContainEqual(expect.objectContaining({
      policyDigest: inspectHarnessPolicy(prepared).digest, ruleIds: ['prepared-read'], source: 'application', executionBackend: 'none'
    }));
    expect(released).toBe(1);
    expect((await f.call({ method: 'policy.get' })).data.policy).toEqual(inspectHarnessPolicy(harness));
  } finally { proceed(); await pending; await prepared.close(); }
}));
