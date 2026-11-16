import { expect, test } from 'bun:test';
import { fixture, fixtures, grade } from '../scripts/benchmarks/context-live/fixtures.js';
import { createContextLiveMeter } from '../scripts/benchmarks/context-live/meter.js';
for (const name of fixtures) test(`live fixture ${name} retains hidden facts and grades all context fields`, () => {
  const data = fixture(name, 0);
  for (const path of ['src/01.txt', 'src/02.txt', 'src/03.txt']) {
    expect(data.files[path]!.length).toBeGreaterThan(8000);
    expect(data.files[path]!.length).toBeLessThan(16000);
    expect(data.files[path]!.slice(0, 1200) + data.files[path]!.slice(-1200)).not.toContain('AUTHORITATIVE');
  }
  expect(data.expected.decision).toBe(data.expected.total <= data.expected.threshold ? 'release' : 'hold');
  expect(data.expected.decision).toBe(name === 'correction' ? 'hold' : 'release');
  expect(grade(JSON.stringify(data.expected), data.expected).passed).toBe(true);
  for (const key of Object.keys(data.expected)) expect(grade(JSON.stringify({ ...data.expected, [key]: 'wrong' }), data.expected).passed).toBe(false);
  expect(grade('{}', data.expected).passed).toBe(false);
});
test('live meter records billed usage/cache and rejects wrong model before network', async () => {
  let requests = 0;
  const native = (async (_input, init) => {
    requests++; expect(JSON.parse(init!.body as string).prompt_cache_key).toStartWith('harness-cold-');
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6-luna', usage: {
      input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 }
    } } }) + '\n\n');
  }) as typeof fetch;
  const meter = createContextLiveMeter(native, 'gpt-6-luna', 'low', () => performance.now(), 2048, true, 8);
  const init = { method: 'POST', body: JSON.stringify({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, max_output_tokens: 2048 }) };
  await (await meter.fetch('https://api.openai.com/v1/responses', init)).text();
  expect(meter.snapshot()[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40, reasoningTokens: 10 });
  await expect(meter.fetch('https://api.openai.com/v1/responses', { ...init, body: init.body.replace('gpt-6-luna', 'wrong') })).rejects.toThrow();
  expect(requests).toBe(1);
});

test('installed OpenAI SDK continuation omits historical projection and prepended guidance unless stateless', async () => {
  const { createOpenAI } = await import('@zhivex-ai/openai');
  const bodies: Record<string, any>[] = [];
  const model = createOpenAI({ apiKey: 'test-not-a-real-key', fetch: (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return Response.json({ id: 'resp_test', status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } });
  }) as typeof fetch })('gpt-6-luna');
  const messages: import('@zhivex-ai/core').ModelMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: 'UPDATED POLICY bun-only' }] },
    { role: 'user', parts: [{ type: 'text', text: 'HISTORICAL PROJECTION SHOULD BE TRANSMITTED' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Earlier response' }, { type: 'provider-data', provider: 'openai', data: { responseId: 'resp_previous' } }] },
    { role: 'user', parts: [{ type: 'text', text: 'Continue' }] }
  ];
  await model.generate({ messages, providerOptions: { apiMode: 'responses' }, maxRetries: 0 });
  await model.generate({ messages, providerOptions: { apiMode: 'responses', store: false }, maxRetries: 0 });
  const { providerModelInternals } = await import('../packages/core/src/providers/providers.js');
  await providerModelInternals.withOpenAIToolResultEnvelopes(model).generate({ messages, providerOptions: { apiMode: 'responses' }, maxRetries: 0 });
  expect(bodies[2]!.store).toBe(false);
  expect(bodies[2]!.previous_response_id).toBeUndefined();
  expect(JSON.stringify(bodies[2]!.input)).toContain('HISTORICAL PROJECTION');
  expect(JSON.stringify(bodies[2]!.input)).toContain('UPDATED POLICY');
  expect(bodies[0]!.previous_response_id).toBe('resp_previous');
  expect(JSON.stringify(bodies[0]!.input)).not.toContain('HISTORICAL PROJECTION');
  expect(JSON.stringify(bodies[0]!.input)).not.toContain('UPDATED POLICY');
  expect(bodies[1]!.previous_response_id).toBeUndefined();
  expect(JSON.stringify(bodies[1]!.input)).toContain('HISTORICAL PROJECTION');
  expect(JSON.stringify(bodies[1]!.input)).toContain('UPDATED POLICY');
});
