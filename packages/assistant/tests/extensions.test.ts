import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { GENERAL_ASSISTANT_PROFILE } from '@zhivex-ai/harness/engine';
import { createCompatibleProvider, parseCompatibleProvider } from '../src/providers/openai-compatible.js';
import { openAssistantModules, type AssistantModule } from '../src/modules/module.js';
import { createMcpModule, startAssistantHost, connectAssistant, loadAssistantConfig } from '../src/index.js';

const config = { kind: 'openai-compatible' as const, baseURL: 'https://models.example.test/v1', apiKeyEnv: 'ASSISTANT_TEST_KEY', model: 'private-model', apiMode: 'chat' as const,
  capabilities: { streaming: true as const, tools: true as const, toolChoice: true } };
const messages = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] }];

test('compatible profiles reject ambiguous endpoints/secrets and bind config but not credential values', () => {
  for (const patch of [{ baseURL: 'http://remote.example/v1' }, { baseURL: 'https://key:secret@example.test/v1' }, { baseURL: 'https://example.test/v1?key=secret' }, { apiMode: 'auto' }, { apiKey: 'inline' }, { capabilities: { streaming: true, tools: false } }]) {
    expect(() => parseCompatibleProvider({ ...config, ...patch })).toThrow('CONFIG_INVALID');
  }
  expect(() => createCompatibleProvider(config, { env: {} })).toThrow('CREDENTIAL_MISSING');
  const first = createCompatibleProvider(config, { env: { ASSISTANT_TEST_KEY: 'first-secret' } });
  const second = createCompatibleProvider(config, { env: { ASSISTANT_TEST_KEY: 'second-secret' } });
  expect(first.binding).toBe(second.binding); expect(JSON.stringify(first.config)).not.toContain('first-secret');
  expect(createCompatibleProvider({ ...config, apiMode: 'responses' }, { env: { ASSISTANT_TEST_KEY: 'first-secret' } }).binding).not.toBe(first.binding);
  expect(first.model.capabilities.tools).toBe(true);
});

for (const apiMode of ['chat','responses'] as const) test(`configured ${apiMode} routes generate and streaming with an unknown model`, async () => {
  const paths: string[] = [], bodies: any[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(String(input)); const body = JSON.parse(String(init?.body)); bodies.push(body);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-secret');
    if (body.stream) {
      const events = apiMode === 'chat' ? [
        { id: 'r1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
        { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ] : [
        { type: 'response.output_text.delta', delta: 'Hello', output_index: 0, content_index: 0, item_id: 'm1' },
        { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json(apiMode === 'chat' ? { id: 'r1', choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } :
      { id: 'r1', status: 'completed', output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  const { model } = createCompatibleProvider({ ...config, apiMode }, { env: { ASSISTANT_TEST_KEY: 'private-secret' }, fetcher });
  const generated = await model.generate({ messages, providerOptions: { apiMode: apiMode === 'chat' ? 'responses' : 'chat' } });
  expect(generated.text).toBe('Hello');
  const events = []; for await (const event of await model.stream!({ messages })) events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', textDelta: 'Hello' }));
  expect(paths.every(path => path.endsWith(apiMode === 'chat' ? '/chat/completions' : '/responses'))).toBe(true);
  expect(bodies.every(body => body.model === 'private-model')).toBe(true);
});

function module(id: string, closed: string[] = []): AssistantModule {
  return { id, version: '1', async open() { return { binding: `${id}-account`,
    profile: { ...GENERAL_ASSISTANT_PROFILE, id: `${id}-assistant`, toolNames: [`${id}_read_get`] },
    mcpConfiguration: { schemaVersion: 1, servers: [{ name: `${id}_read`, transport: 'custom', includeTools: ['get'], permissions: ['read'], trustServerToolAnnotations: true }] },
    mcpClients: { [`${id}_read`]: { async listTools() { return { tools: [{ name: 'get', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }; }, async callTool() { return { content: [{ type: 'text', text: 'OK' }] }; } } },
    async close() { closed.push(id); } }; } };
}
const context = { directory: '/unused', ownerId: 'owner', recover: false };
test('modules compose deterministically, namespace tools and close all resources on startup failure', async () => {
  const closed: string[] = [], a = module('notes', closed), b = module('tasks', closed);
  const first = await openAssistantModules([b,a], context), second = await openAssistantModules([a,b], context);
  expect(first.profile).toEqual(second.profile); expect(first.profile.toolNames).toEqual(['notes_read_get','tasks_read_get']);
  await first.close(); await first.close(); await second.close(); expect(closed).toEqual(['tasks','notes','tasks','notes']);
  await expect(openAssistantModules([a,a], context)).rejects.toThrow('ID_INVALID');
  const broken = { ...b, async open() { throw new Error('OPEN_FAILED'); } };
  await expect(openAssistantModules([a,broken], context)).rejects.toThrow('OPEN_FAILED'); expect(closed.at(-1)).toBe('notes');
  const wrong = { ...a, async open() { const value = await a.open(context); value.profile.toolNames = ['tasks_read_get']; return value; } };
  await expect(openAssistantModules([wrong], context)).rejects.toThrow('TOOL_COLLISION');
});

test('configuration supports allowlisted modules, rejects executable imports and inline credentials', async () => {
  const directory = await mkdtemp('/tmp/assistant-config-'), filename = directory + '/assistant.json';
  try {
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, provider: config, modules: [{ kind: 'mcp', id: 'notes', version: '1', instructions: 'Read notes.', configuration: {
      schemaVersion: 1, servers: [{ name: 'notes_remote', transport: 'http', url: 'https://mcp.example.test', includeTools: ['search'], permissions: ['read','network'] }]
    } }] }), { mode: 0o600 });
    const loaded = await loadAssistantConfig(filename); expect(loaded.modules.map(m => m.id)).toEqual(['notes']); expect(loaded.compatibleProvider?.apiMode).toBe('chat');
    for (const invalid of [{ schemaVersion: 1, modules: [{ kind: 'import', path: './untrusted.js' }] }, { schemaVersion: 1, provider: { ...config, apiKey: 'secret' } }]) {
      await writeFile(filename, JSON.stringify(invalid)); await expect(loadAssistantConfig(filename)).rejects.toThrow('CONFIG_INVALID');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('module changes cannot reuse a bound host; read-only MCP module executes through Harness', async () => {
  const directory = await mkdtemp('/tmp/assistant-modules-'); let host;
  try {
    const model = createMockLanguageModel({ streamEvents: [[{ type: 'tool-call', toolCall: { id: 'c1', name: 'notes_read_get', input: {} } }, { type: 'finish', finishReason: 'tool-calls' }], [{ type: 'text-delta', textDelta: 'Notes read' }, { type: 'finish', finishReason: 'stop' }]] });
    host = await startAssistantHost({ directory, ownerId: 'owner', modules: [module('notes'), module('tasks')], engine: { modelInstance: model } });
    const client = await connectAssistant(host.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Modules', idempotencyKey: 'create' });
    if (!created.ok || created.data.kind !== 'session') throw new Error('Session failed');
    const session = created.data.session;
    const result = await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Read notes' });
    expect(result).toMatchObject({ ok: true, data: { kind: 'run', run: { status: 'completed' } } });
    await host.close();
    await expect(startAssistantHost({ directory, ownerId: 'owner', modules: [module('notes')], engine: { modelInstance: model } })).rejects.toThrow('BINDING_MISMATCH');
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const apiMode of ['chat', 'responses'] as const) test(`compatible ${apiMode} tool approval survives host restart and duplicate resolution`, async () => {
  const directory = await mkdtemp('/tmp/assistant-compatible-'); let effects = 0, requests = 0;
  const oldKey = process.env.ASSISTANT_TEST_KEY; process.env.ASSISTANT_TEST_KEY = 'local-test-secret';
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests++;
    const resumed = JSON.stringify(body).includes('effect-confirmed');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let events: unknown[];
    if (apiMode === 'chat') events = resumed ? [
      { id: 'r2', choices: [{ index: 0, delta: { content: 'Completed once' }, finish_reason: null }] },
      { id: 'r2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ] : [
      { id: 'r1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'notes_write_put', arguments: '{}' } }] }, finish_reason: null }] },
      { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ];
    else events = resumed ? [
      { type: 'response.output_text.delta', delta: 'Completed once', output_index: 0, content_index: 0, item_id: 'm1' },
      { type: 'response.completed', response: { id: 'r2', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item1', output_index: 0, delta: '{}' },
      { type: 'response.function_call_arguments.done', item_id: 'item1', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '{}' } },
      { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [{ id: 'item1', type: 'function_call', call_id: 'call1', name: 'notes_write_put', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listen failed');
  const provider = { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, allowInsecureLocalhost: true, apiMode };
  const notes = () => createMcpModule({ id: 'notes', version: '1', instructions: 'Use notes_write_put only with approval.', configuration: {
    schemaVersion: 1, servers: [{ name: 'notes_write', transport: 'custom', includeTools: ['put'], permissions: ['write'] }]
  }, clients: { notes_write: { async listTools() { return { tools: [{ name: 'put', description: 'Persist a note.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; },
    async callTool() { effects++; return { content: [{ type: 'text', text: 'effect-confirmed' }] }; } } } });
  let host: Awaited<ReturnType<typeof startAssistantHost>> | undefined;
  try {
    host = await startAssistantHost({ directory, ownerId: 'owner', compatibleProvider: provider, modules: [notes()] });
    let client = await connectAssistant(host.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Compatible', idempotencyKey: 'create' });
    if (!created.ok || created.data.kind !== 'session') throw new Error('Session failed');
    const session = created.data.session;
    const pending = await client.command({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Write a note' });
    expect(pending).toMatchObject({ ok: true, data: { kind: 'run', run: { status: 'waiting_approval' } } }); expect(effects).toBe(0);
    if (!pending.ok || pending.data.kind !== 'run') throw new Error('Run failed');
    const runId = pending.data.run.runId; await host.close();
    await expect(startAssistantHost({ directory, ownerId: 'owner', compatibleProvider: { ...provider, model: 'different-model' }, modules: [notes()] })).rejects.toThrow('BINDING_MISMATCH');
    host = await startAssistantHost({ directory, ownerId: 'owner', compatibleProvider: provider, modules: [notes()] });
    client = await connectAssistant(host.credentialsPath);
    const current = await client.command({ method: 'run.get', sessionId: session.sessionId, runId, includeReview: true });
    if (!current.ok || current.data.kind !== 'run') throw new Error('Run missing');
    const decision = { method: 'approval.resolve' as const, sessionId: session.sessionId, runId, expectedRevision: current.data.run.revision, idempotencyKey: 'approve',
      decisions: current.data.run.approvals.map(approval => ({ approvalId: approval.approvalId, digest: approval.digest, approve: true })) };
    expect(await client.command(decision)).toMatchObject({ ok: true, data: { kind: 'run', run: { status: 'completed' } } });
    await client.command(decision); expect(effects).toBe(1); expect(requests).toBe(2);
    expect(await readFile(directory + '/state/host.json', 'utf8')).not.toContain('local-test-secret');
  } finally {
    await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldKey === undefined) delete process.env.ASSISTANT_TEST_KEY; else process.env.ASSISTANT_TEST_KEY = oldKey;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test('official OpenAI chat uses the same token budget parameter for generation and streaming', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (body.max_tokens !== undefined) return Response.json({ error: { param: 'max_tokens' } }, { status: 400 });
    if (body.stream) return new Response('data: {"id":"r","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ id:'r', choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}] });
  }) as typeof fetch;
  const { model } = createCompatibleProvider({ ...config, baseURL:'https://api.openai.com/v1', model:'gpt-6-luna', apiMode:'chat' }, { env: { ASSISTANT_TEST_KEY:'offline-key' }, fetcher });
  expect((await model.generate({ messages, maxTokens:64 })).text).toBe('OK');
  const events=[]; for await(const event of await model.stream!({messages,maxTokens:64}))events.push(event);
  expect(events).toContainEqual(expect.objectContaining({type:'text-delta',textDelta:'OK'}));
  expect(bodies).toHaveLength(2);
  for(const body of bodies){expect(body.max_completion_tokens).toBe(64);expect(body).not.toHaveProperty('max_tokens');}
});

test('web search is explicit, Responses-only, preserves old bindings and retains citations', async () => {
  const official = { ...config, baseURL:'https://api.openai.com/v1', apiMode:'responses' as const };
  const options = { env: { ASSISTANT_TEST_KEY:'offline-key' } };
  const plain = createCompatibleProvider(official, options);
  expect(plain.config).not.toHaveProperty('webSearch');
  expect(() => createCompatibleProvider({ ...official, webSearch:true, apiMode:'chat' }, options)).toThrow('CONFIG_INVALID');
  expect(() => createCompatibleProvider({ ...official, webSearch:true, baseURL:'https://proxy.test/v1' }, options)).toThrow('CONFIG_INVALID');
  const text = 'Buenos Aires: 20 °C. Fuente';
  const item = {id:'msg1',type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[{type:'url_citation',start_index:text.indexOf('Fuente'),end_index:text.length,title:'Weather',url:'https://weather.test/current'}]}]};
  const bodies: any[] = [];
  const fetcher = (async (_: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const response = {id:'r1',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    if (!body.stream) return Response.json(response);
    return new Response([
      {type:'response.output_text.delta',delta:text,output_index:0,content_index:0,item_id:'msg1'},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response}
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const searched = createCompatibleProvider({...official,webSearch:true},{...options,fetcher});
  expect(searched.binding).not.toBe(plain.binding);
  const expected = 'Buenos Aires: 20 °C. [Weather](https://weather.test/current)';
  expect((await searched.model.generate({messages})).text).toBe(expected);
  let streamed=''; for await (const event of await searched.model.stream!({messages})) if(event.type==='text-delta')streamed+=event.textDelta;
  expect(streamed).toBe(expected);
  for(const body of bodies)expect(body.tools).toContainEqual({type:'web_search'});
});
