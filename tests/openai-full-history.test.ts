import { test, expect } from 'bun:test';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { providerModelInternals } from '../packages/core/src/providers/providers.js';
for (const mode of ['generate', 'stream'] as const) test(`OpenAI ${mode} owns history without widening tool authorization`, async () => {
  const base = createMockLanguageModel();
  let received: any;
  base.generate = async input => { received = input; return {text:'ok', finishReason:'stop'}; };
  base.stream = async input => { received = input; return (async function* () {yield {type:'finish' as const, finishReason:'stop' as const};})(); };
  const wrapped = providerModelInternals.withOpenAIToolResultEnvelopes(base);
  const invoke = async (providerOptions: any) => {
    const input = {messages:[], tools:{}, providerOptions};
    if (mode === 'generate') await wrapped.generate(input);
    else for await (const _ of await wrapped.stream!(input)) {}
  };
  await invoke({apiMode:'responses', store:true});
  expect(received.providerOptions.store).toBe(false);
  expect(received.toolResultFormat).toBe('envelope');
  expect(received.tools).toEqual({});
  for (const options of [{previous_response_id:'resp_x'}, {conversation:'conv_x'}])
    await expect(invoke(options)).rejects.toThrow('server-side continuation');
  await invoke({apiMode:'chat', store:true});
  expect(received.providerOptions).toEqual({apiMode:'chat', store:true});
});
