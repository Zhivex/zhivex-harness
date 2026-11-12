import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createAssistantProvider, parseAssistantProvider } from '../src/providers/provider.js';
import { startAssistantHost } from '../src/host.js';
import { connectAssistant } from '../src/client.js';
import { createMcpModule } from '../src/modules/mcp.js';
import { loadAssistantConfig } from '../src/config.js';
import { testProvider } from '../src/web/setup.js';

const native = (kind: 'meta' | 'qwen') => ({ kind, model: kind === 'meta' ? 'muse-spark-1.3' : 'qwen3.6-plus', apiKeyEnv: 'ASSISTANT_NATIVE_TEST_KEY' });

test('native configuration validates provider fields and binds transport without secrets', async () => {
  const first = createAssistantProvider(native('qwen'), { env: { ASSISTANT_NATIVE_TEST_KEY: 'first' } });
  expect(first.provider).toBe('qwen');
  expect(createAssistantProvider(native('qwen'), { env: { ASSISTANT_NATIVE_TEST_KEY: 'second' } }).binding).toBe(first.binding);
  expect(createAssistantProvider({ ...native('qwen'), kind: 'qwen', region: 'beijing', workspaceId: 'team' }, { env: { ASSISTANT_NATIVE_TEST_KEY: 'first' } }).binding).not.toBe(first.binding);
  expect(createAssistantProvider({ ...native('qwen'), kind: 'qwen', workspaceId: 'team' }, { env: { ASSISTANT_NATIVE_TEST_KEY: 'first' } }).binding).not.toBe(first.binding);
  for (const patch of [{ kind: 'muse' }, { region: 'wrong' }, { webSearch: true }, { apiKey: 'secret' }, { baseURL: 'https://other.test' }, { workspaceId: 'other.test/path' }]) {
    expect(() => parseAssistantProvider({ ...native('qwen'), ...patch })).toThrow('CONFIG_INVALID');
  }
  expect(() => createAssistantProvider(native('meta'), { env: {} })).toThrow('CREDENTIAL_MISSING');
  const directory = await mkdtemp('/tmp/assistant-native-config-');
  try {
    for (const kind of ['meta', 'qwen'] as const) {
      await writeFile(directory+'/config.json', JSON.stringify({schemaVersion:1,provider:native(kind)}), {mode:0o600});
      expect((await loadAssistantConfig(directory+'/config.json')).assistantProvider?.kind).toBe(kind);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
for (const kind of ['meta', 'qwen'] as const) test(`native ${kind} tool approval survives host restart and duplicate resolution`, async () => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp('/tmp/assistant-native-'); let effects = 0, requests = 0;
  const oldKey = process.env.ASSISTANT_NATIVE_TEST_KEY; process.env.ASSISTANT_NATIVE_TEST_KEY = 'local-test-secret';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    expect(url).toContain(kind === 'meta' ? 'api.meta.ai/v1/responses' : 'dashscope-intl.aliyuncs.com/compatible-mode/v1/responses');
    const body = JSON.parse(String(init?.body)); requests++;
    const resumed = JSON.stringify(body).includes('effect-confirmed');
    let events: unknown[];
    events = resumed ? [
      { type: 'response.output_text.delta', delta: 'Completed once', output_index: 0, content_index: 0, item_id: 'm1' },
      { type: 'response.completed', response: { id: 'r2', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item1', output_index: 0, delta: '{}' },
      { type: 'response.function_call_arguments.done', item_id: 'item1', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '{}' } },
      { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [{ id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const provider = native(kind);
  const notes = () => createMcpModule({ id: 'notes', version: '1', instructions: 'Use notes_write_put only with approval.', configuration: {
    schemaVersion: 1, servers: [{ name: 'notes_write', transport: 'custom', includeTools: ['put'], permissions: ['write'] }]
  }, clients: { notes_write: { async listTools() { return { tools: [{ name: 'put', description: 'Persist a note.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; },
    async callTool() { effects++; return { content: [{ type: 'text', text: 'effect-confirmed' }] }; } } } });
  let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    host = await startAssistantHost({ directory, ownerId: 'owner', assistantProvider: provider, modules: [notes()] });
    expect(host.diagnostics().provider?.kind).toBe(kind);
    let client = await connectAssistant(host.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Native', idempotencyKey: 'create' });
    if (!created.ok || created.data.kind !== 'session') throw new Error('Session failed');
    const session = created.data.session;
    const pending = await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Write a note' });
    expect(pending).toMatchObject({ ok: true, data: { kind: 'run', run: { status: 'waiting_approval' } } }); expect(effects).toBe(0);
    if (!pending.ok || pending.data.kind !== 'run') throw new Error('Run failed');
    const runId = pending.data.run.runId; await host.close();
    await expect(startAssistantHost({ directory, ownerId: 'owner', assistantProvider: { ...provider, model: 'different-model' }, modules: [notes()] })).rejects.toThrow('BINDING_MISMATCH');
    host = await startAssistantHost({ directory, ownerId: 'owner', assistantProvider: provider, modules: [notes()] });
    client = await connectAssistant(host.credentialsPath);
    const current = await client.command({ method: 'run.get', sessionId: session.sessionId, runId, includeReview: true });
    if (!current.ok || current.data.kind !== 'run') throw new Error('Run missing');
    const decision = { method: 'approval.resolve' as const, sessionId: session.sessionId, runId, expectedRevision: current.data.run.revision, idempotencyKey: 'approve',
      decisions: current.data.run.approvals.map(approval => ({ approvalId: approval.approvalId, digest: approval.digest, approve: true })) };
    expect(await client.command(decision)).toMatchObject({ ok: true, data: { kind: 'run', run: { status: 'completed' } } });
    await client.command(decision); expect(effects).toBe(1); expect(requests).toBe(2);
    expect(await readFile(directory + '/state/host.json', 'utf8')).not.toContain('local-test-secret');
  } finally {
    await host?.close(); globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.ASSISTANT_NATIVE_TEST_KEY; else process.env.ASSISTANT_NATIVE_TEST_KEY = oldKey;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

for (const kind of ['meta','qwen'] as const) test(`native ${kind} access probe uses adapter and redacts authentication errors`, async () => {
  const originalFetch = globalThis.fetch;
  const value = {kind, model:native(kind).model, apiKey:'probe-secret'};
  try {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toContain(kind === 'meta' ? '/responses' : '/chat/completions');
      expect(String(init?.body)).toContain('Reply only OK');
      if (kind === 'qwen') return Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
      return Response.json({id:'probe',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
    }) as typeof fetch;
    await testProvider(value);
    globalThis.fetch = Object.assign(async () => Response.json({error:{message:'private upstream error'}},{status:401}), { preconnect: originalFetch.preconnect });
    await expect(testProvider(value)).rejects.toThrow('SETUP_PROVIDER_AUTH');
  } finally { globalThis.fetch = originalFetch; }
});

for (const service of ['qwencloud', 'token-plan'] as const) test(`Qwen ${service} uses its endpoint for probe and streaming`, async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const config = { kind:'qwen' as const, service, model:'qwen3.8-flash', apiKeyEnv:'KEY' };
  try {
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      if (body.stream) return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'OK',output_index:0,content_index:0,item_id:'m1'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{id:'r1',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}})+'\n\n', {headers:{'content-type':'text/event-stream'}});
      return Response.json({id:'r1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]});
    }) as typeof fetch;
    await testProvider({kind:'qwen', service, model:'qwen3.8-flash', apiKey:'test-key'});
    const provider = createAssistantProvider(config, {env:{KEY:'test-key'}});
    const events = [];
    for await (const event of await provider.model.stream!({messages:[{role:'user',parts:[{type:'text',text:'Hi'}]}]})) events.push(event);
    expect(events).toContainEqual({type:'text-delta',textDelta:'OK'});
    expect(urls).toHaveLength(2);
    expect(urls.every(url => url.startsWith(service === 'qwencloud' ? 'https://maas.qwencloudapi.com/compatible-mode/v1/' : 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/'))).toBe(true);
    expect(provider.binding).not.toBe(createAssistantProvider({...config,service:'model-studio'},{env:{KEY:'test-key'}}).binding);
  } finally { globalThis.fetch = originalFetch; }
});
