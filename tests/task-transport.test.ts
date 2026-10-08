import { expect, test } from 'bun:test';
import { GoogleAuth } from 'google-auth-library';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { wrapLanguageModel, type ModelGenerateInput } from '@zhivex-ai/core';
import { createProviderModel } from '../src/runtime/config.js';
import { TaskBudget } from '../src/runtime/task-budget.js';
import { isTaskTransportModel } from '../src/runtime/task-transport.js';

// Actual installed SDK adapters, synthetic HTTP and credentials only. These
// contracts verify dispatch/accounting controls, never provider/model quality.
const routes = [
  { provider: 'openai', model: 'gpt-6-luna', env: { OPENAI_API_KEY: 'synthetic' } },
  { provider: 'anthropic', model: 'claude-sonnet-5', env: { ANTHROPIC_API_KEY: 'synthetic' } },
  { provider: 'gemini', model: 'gemini-3.7-flash', env: { GEMINI_API_KEY: 'synthetic' } },
  { provider: 'qwen', model: 'qwen3.6-plus', env: { DASHSCOPE_API_KEY: 'synthetic' } },
  { provider: 'vertex', model: 'gemini-2.5-flash', env: { GOOGLE_CLOUD_PROJECT: 'fixture-project', VERTEX_LOCATION: 'us-central1' } }
] as const;

function response(provider: string, stream: boolean) {
  const google = { candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
  const openai = { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const qwen = { choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, delta: { content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  const anthropic = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  if (!stream) return Response.json(provider === 'openai' ? openai : provider === 'qwen' ? qwen : provider === 'anthropic' ? anthropic : google);
  const payload = provider === 'anthropic' ? [
    `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {}\n\n'
  ].join('') : `data: ${JSON.stringify(provider === 'openai' ? { type: 'response.completed', response: openai } : provider === 'qwen' ? qwen : google)}\n\n`;
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
}

for (const route of routes) test(`ordinary ${route.provider} retains explicitly configured transport retry`, async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = GoogleAuth.prototype.getAccessToken;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => ++calls === 1
    ? Response.json({ error: { message: 'synthetic unavailable' } }, { status: 503 }) : response(route.provider, false),
  { preconnect: originalFetch.preconnect });
  GoogleAuth.prototype.getAccessToken = async () => 'synthetic-token';
  try {
    const model = createProviderModel({ provider: route.provider, model: route.model }, route.env);
    const input: ModelGenerateInput = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 20, maxRetries: 1, retryBackoffMs: 0,
      providerOptions: route.provider === 'qwen' ? { apiMode: 'chat' } : route.provider === 'openai' ? { apiMode: 'responses' } : {} };
    const result = await model.generate(input);
    expect(calls).toBe(2);
    expect(input.maxRetries).toBe(1);
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  } finally {
    globalThis.fetch = originalFetch;
    GoogleAuth.prototype.getAccessToken = originalToken;
  }
});

for (const route of routes) for (const transport of ['generate', 'stream'] as const)
  for (const auxiliary of [false, true]) for (const failure of [false, true]) {
    test(`vetted ${route.provider} ${transport} ${auxiliary ? 'compaction' : 'primary'} ${failure ? '503 admits one dispatch' : 'wire cap and receipt'}`, async () => {
      const originalFetch = globalThis.fetch;
      const originalToken = GoogleAuth.prototype.getAccessToken;
      let calls = 0;
      const bodies: Record<string, any>[] = [];
      globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
        calls++;
        bodies.push(JSON.parse(String(init?.body)));
        return failure ? Response.json({ error: { message: 'synthetic unavailable' } }, { status: 503 }) : response(route.provider, transport === 'stream');
      }, { preconnect: originalFetch.preconnect });
      // The built-in Vertex factory still supplies its real ADC callback; only
      // this credential source is replaced so no token endpoint can be contacted.
      GoogleAuth.prototype.getAccessToken = async () => 'synthetic-token';
      try {
        const model = createProviderModel({ provider: route.provider, model: route.model }, route.env);
        expect(isTaskTransportModel(model)).toBe(true);
        const account = await TaskBudget.open({ store: createInMemoryAgentRunStore(), scope: { tenantId: 'transport-contract' },
          taskId: `${route.provider}-${transport}-${auxiliary}-${failure}`, policy: {
            limits: { inputTokens: 5000, outputTokens: 100, totalTokens: 5100 }, closureReserve: 0 } });
        const input: ModelGenerateInput = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
          maxTokens: 20, maxRetries: 2, providerOptions: route.provider === 'qwen' ? { apiMode: 'chat' } : route.provider === 'openai' ? { apiMode: 'responses' } : {} };
        const wrapped = wrapLanguageModel(model, [account.middleware({ auxiliary })]);
        const pending = account.run('run', async () => {
          if (transport === 'generate') return wrapped.generate(input);
          for await (const _event of await wrapped.stream!(input)) { /* drain actual SDK parsing */ }
        });
        if (failure) await expect(pending).rejects.toThrow(); else await pending;
        expect(calls).toBe(1);
        expect(input.maxRetries).toBe(0);
        expect(input.maxProviderRequests).toBe(1);
        const cap = route.provider === 'openai' ? bodies[0]!.max_output_tokens : route.provider === 'anthropic' ? bodies[0]!.max_tokens
          : route.provider === 'qwen' ? bodies[0]!.max_tokens ?? bodies[0]!.max_completion_tokens : bodies[0]!.generationConfig.maxOutputTokens;
        expect(cap).toBe(20);
        if (failure) expect(await account.summary()).toMatchObject({ usageComplete: false, unknown: { inputTokens: 5000, outputTokens: 20, totalTokens: 5100 } });
        else expect(await account.summary()).toMatchObject({ usageComplete: true, confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      } finally {
        globalThis.fetch = originalFetch;
        GoogleAuth.prototype.getAccessToken = originalToken;
      }
    });
  }

for (const transport of ['generate', 'stream'] as const) for (const auxiliary of [false, true])
  for (const reasoning of [false, true]) for (const failure of [false, true]) {
    test(`vetted OpenAI Chat ${transport} ${auxiliary ? 'compaction' : 'primary'} ${reasoning ? 'reasoning' : 'ordinary'} ${failure ? 'single 503 dispatch' : 'wire cap and receipt'}`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      let body: Record<string, any> | undefined;
      globalThis.fetch = Object.assign(async (url: unknown, init?: RequestInit) => {
        calls++;
        expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
        body = JSON.parse(String(init?.body));
        return failure ? Response.json({ error: { message: 'synthetic unavailable' } }, { status: 503 })
          : response('qwen', transport === 'stream'); // Chat-compatible synthetic receipt.
      }, { preconnect: original.preconnect });
      try {
        const model = createProviderModel({ provider: 'openai', model: 'gpt-6-luna' }, { OPENAI_API_KEY: 'synthetic' });
        const account = await TaskBudget.open({ store: createInMemoryAgentRunStore(), scope: { tenantId: 'chat-contract' },
          taskId: `${transport}-${auxiliary}-${reasoning}-${failure}`, policy: {
            limits: { inputTokens: 5000, outputTokens: 100, totalTokens: 5100 }, closureReserve: 0 } });
        const input: ModelGenerateInput = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
          providerOptions: { apiMode: 'chat' }, maxTokens: 20, maxRetries: 2,
          ...(reasoning ? { reasoning: { effort: 'low' as const } } : {}) };
        const wrapped = wrapLanguageModel(model, [account.middleware({ auxiliary })]);
        const result = account.run('run', async () => {
          if (transport === 'generate') return wrapped.generate(input);
          for await (const _event of await wrapped.stream!(input)) { /* drain SDK Chat parser */ }
        });
        if (failure) await expect(result).rejects.toThrow(); else await result;
        expect(calls).toBe(1);
        expect(body?.[reasoning ? 'max_completion_tokens' : 'max_tokens']).toBe(20);
        expect(body?.[reasoning ? 'max_tokens' : 'max_completion_tokens']).toBeUndefined();
        expect(input.maxRetries).toBe(0);
        expect(input.maxProviderRequests).toBe(1);
        expect(await account.summary()).toMatchObject(failure
          ? { usageComplete: false, unknown: { inputTokens: 5000, outputTokens: 20, totalTokens: 5100 } }
          : { usageComplete: true, confirmed: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      } finally { globalThis.fetch = original; }
    });
  }
