/** Offline consumer reproduction; no model network requests or filesystem effects. */
import { Agent, createInMemoryAgentRunStore, tool } from '@zhivex-ai/core';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { z } from 'zod';
const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
let executions = 0, calls = 0;
let observedUsage: unknown;
const store = createInMemoryAgentRunStore();
const model = createMockLanguageModel({ streamEvents: [
 [{type:'tool-call',toolCall:{id:'unknown',name:'not_in_catalog',input:{}}},{type:'finish',finishReason:'tool-calls',usage}],
 [{type:'tool-call',toolCall:{id:'valid',name:'inspect',input:{}}},{type:'finish',finishReason:'tool-calls',usage}],
 [{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop',usage}]
] });
const original = model.stream!; model.stream = async input => { calls++; const events = await original(input); return (async function* () { for await (const event of events) { if(event.type === 'finish') observedUsage=event.usage; yield event; } })(); };
const agent = new Agent({ model, store, maxSteps: 4, tools: { inspect:tool({name:'inspect',schema:z.object({}),execute:async()=>{executions++;return 'ok';}}) } });
let errorType: string | undefined;
const stream = agent.stream({runId:'unknown-tool-fixture',prompt:'Inspect safely.',toolExecution:{stopOnError:false,validationErrorMode:'tool-result'}});
try { for await (const _event of stream.eventStream) {} await stream.collect(); } catch(error) { errorType=(error as Error).name; await stream.collect().catch(()=>undefined); }
const state = await store.load('unknown-tool-fixture');
console.log(JSON.stringify({sdkCore:'1.14.0',networkCalls:0,modelCalls:calls,validToolExecutions:executions,errorType,status:state?.status,durableSteps:state?.steps.length,durableToolResults:state?.toolResults.length,durableUsage:state?.usage ?? null,observedTransportUsage:observedUsage ?? null},null,2));
