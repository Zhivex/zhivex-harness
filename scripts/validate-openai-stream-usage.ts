/** Offline acceptance probe: incomplete tool calls must not execute and terminal usage must remain observable. */
import { createOpenAI } from '@zhivex-ai/openai';
const events = [
 {type:'response.output_item.added', output_index:0,item:{type:'function_call',id:'fixture-item',call_id:'fixture-call',name:'fixture',arguments:'',status:'in_progress'}},
 {type:'response.function_call_arguments.delta',output_index:0,item_id:'fixture-item',delta:'{"value":'},
 {type:'response.output_item.done',output_index:0,item:{type:'function_call',id:'fixture-item',call_id:'fixture-call',name:'fixture',arguments:'{"value":',status:'incomplete'}},
 {type:'response.incomplete',response:{id:'fixture-response',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:12,output_tokens:8,total_tokens:20},output:[]}}
];
const fixtureFetch = (async () => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;
const model=createOpenAI({apiKey:'fixture',fetch:fixtureFetch})('gpt-5.6-luna');
const emitted: string[]=[]; let failure: string|null=null; let usageObserved=false;
const observeUsage = (value: unknown) => {
  if (value && typeof value === 'object' && 'inputTokens' in value && 'outputTokens' in value && value.inputTokens === 12 && value.outputTokens === 8) usageObserved = true;
};
try {for await (const e of await model.stream!({messages:[{role:'user',parts:[{type:'text',text:'fixture'}]}],providerOptions:{apiMode:'responses'}})) {
  emitted.push(e.type);
  if ('usage' in e) observeUsage(e.usage);
}}
catch(error) {failure=(error as {reason?:string}).reason ?? 'other';observeUsage((error as {usage?:unknown}).usage);}
console.log(JSON.stringify({fixtureTerminalUsage:{inputTokens:12,outputTokens:8},emitted,failure,usageObserved,network:'mock-only'}));

if (failure !== "incomplete_arguments" || !usageObserved || emitted.includes("tool-call")) process.exitCode = 1;
