import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tool,wrapLanguageModel,type AgentRunState,type ModelMessage} from '@zhivex-ai/core';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {z} from 'zod';
import {replayCompactedReads} from '../packages/core/src/context/working-read-replay.js';
import {collectReadAttempts} from '../packages/core/src/context/read-attempts.js';
import {createRequestProjection} from '../packages/core/src/context/request-projection.js';
import {createModelBudget} from '../packages/core/src/runtime/model-budget.js';
import {createHarness,runHarness} from '../packages/core/src/runtime/harness.js';
const tools={read_file:tool({name:'read_file',schema:z.object({path:z.string()}),execute:()=>null})};
const call={id:'old',name:'read_file',input:{path:'old.txt'}};
const output={path:'old.txt',content:'OLD_EVIDENCE '+ 'abcdefgh '.repeat(1500)};
const result={toolCallId:'old',toolName:'read_file',output,isError:false};
const state={runId:'one',compactions:[{}],steps:[{index:0,response:{messages:[{role:'assistant',parts:[{type:'tool-call',toolCall:call}]}]},toolResults:[result]}],toolResults:[result]} as unknown as AgentRunState;
const messages:ModelMessage[]=[{role:'system',parts:[{type:'text',text:'Host policy'}]},{role:'assistant',parts:[{type:'text',text:'[Compacted prior conversation]\nsummary'}]}];
test('durable read replay is exact, chronological, idempotent and does not mutate storage',()=>{
 const saved=structuredClone(state);const replay=replayCompactedReads(messages,state,tools);
 expect(replay[0]).toEqual(messages[0]);expect(replay.at(-1)).toEqual(messages.at(-1));
 expect(replay[2]!.parts[0]).toEqual({type:'tool-result',toolResult:result});
 expect(replayCompactedReads(replay,state,tools)).toEqual(replay);expect(state).toEqual(saved);
 expect(replayCompactedReads(messages,undefined,tools)).toEqual(messages);
 expect(replayCompactedReads(messages,{...state,compactions:[]},tools)).toEqual(messages);
 expect(replayCompactedReads(messages,state,{})).toEqual(messages);
 expect(()=>replayCompactedReads(messages,{...state,steps:[]},tools)).toThrow('COMPACTED_READ_CALL_UNAVAILABLE');
});
test('real transport budget counts replayed bytes and refuses before provider execution',async()=>{
 let dispatched=false;const base=createMockLanguageModel();base.generate=async()=>{dispatched=true;return{text:'bad',finishReason:'stop'};};
 const budget=createModelBudget({inputTokens:1000,outputTokens:1000},{reserveFraction:0});
 const model=wrapLanguageModel(wrapLanguageModel(base,[budget.middleware]),[createRequestProjection(async()=>state)]);
 await expect(model.generate({messages,tools})).rejects.toThrow('WORK_TOKEN_BUDGET');
 expect(dispatched).toBe(false);expect(budget.stats.predictedInputTokens).toBeGreaterThan(1000);
});
test('six reads survive repeated SDK compaction without extra recovery or losing latest facts',async()=>{
 const root=await mkdtemp('/tmp/read-replay-integration-');let step=0;let diagnostics:any;
 const base=createMockLanguageModel();base.stream=async input=>{
  const current=step++;
  if(current===6){const text=JSON.stringify(input.messages);for(let n=0;n<6;n++)expect(text).toContain(`FACT_${n}_UNCHANGED`);}
  return(async function*(){if(current<6)yield{type:'tool-call' as const,toolCall:{id:`read-${current}`,name:'read_file',input:{path:`${current}.txt`,startLine:1,endLine:2000}}};else yield{type:'text-delta' as const,textDelta:'complete'};
   yield{type:'finish' as const,finishReason:current<6?'tool-calls' as const:'stop' as const};})();
 };
 const harness=await createHarness({workspace:root,provider:'openai',modelInstance:base,toolNames:['read_file','read_tool_result','discover_tools'],subagentProfiles:[],projectContext:false,unlimitedTokens:true,compactionMaxEstimatedInputTokens:6000});
 try{
  for(let n=0;n<6;n++)await writeFile(`${root}/${n}.txt`,Array.from({length:70},(_,i)=>`file${n} line${i} `+'abcdefg '.repeat(15)).join('\n')+`\nFACT_${n}_UNCHANGED`);
  const output=await runHarness(harness,{prompt:'Read every file then finish.',maxSteps:8},{onDiagnostics:d=>{diagnostics=d;}});
  expect(output.status).toBe('completed');expect(output.state.compactions!.length).toBeGreaterThan(1);
  expect(step).toBe(7);expect(output.toolResults).toHaveLength(6);
  expect(output.state.messages.length).toBeLessThan(10);
  expect(JSON.stringify(output.state.messages)).not.toContain('Historical reads restored');
  expect(diagnostics.readAttempts.totalAttempts).toBe(6);expect(diagnostics.readAttempts.omittedAttempts).toBe(0);
 }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});
test('failed reads retain original attempted paths in diagnostics and durable steps',async()=>{
 const root=await mkdtemp('/tmp/read-attempt-failure-');let diagnostics:any;
 const base=createMockLanguageModel({streamEvents:[...['.env','missing.txt'].map((path,i)=>[
 {type:'tool-call' as const,toolCall:{id:`fail-${i}`,name:'read_file',input:{path}}},{type:'finish' as const,finishReason:'tool-calls' as const}]),
 [{type:'text-delta' as const,textDelta:'done'},{type:'finish' as const,finishReason:'stop' as const}]]});
 const harness=await createHarness({workspace:root,provider:'openai',modelInstance:base,toolNames:['read_file'],subagentProfiles:[],projectContext:false,unlimitedTokens:true});
 try{
  await writeFile(`${root}/.env`,'DO_NOT_DISCLOSE_TEST_CANARY');
  const output=await runHarness(harness,{prompt:'Check reads.'},{onDiagnostics:d=>{diagnostics=d;}});
  const persisted=await harness.store.load(output.state.runId,output.state.scope);
  expect(diagnostics.readAttempts).toEqual(collectReadAttempts(persisted!.steps));
  expect(diagnostics.readAttempts.attempts.map((a:any)=>a.attemptedPaths)).toEqual([['.env'],['missing.txt']]);
  expect(diagnostics.readAttempts.attempts.every((a:any)=>a.outcome==='failed'&&a.argumentsRecorded)).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain('DO_NOT_DISCLOSE_TEST_CANARY');
 }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});

test('cached replay preserves every character and invalidates changed results across scope/revision',async()=>{
 const {createWorkingReadReplay}=await import('../packages/core/src/context/working-read-replay.js');
 const {decodeLosslessLines}=await import('../packages/core/src/context/lossless-lines.js');
 const replay=createWorkingReadReplay();
 const content=Array.from({length:100},(_,i)=>`${i}: ${'safe 😀 '.repeat(20)}`).join('\n')+'\r\nUNIQUE_TAIL';
 const changed={...result,output:{...output,content}};
 const saved={...state,revision:1,toolResults:[changed]};
 const first=replay(messages,saved,tools);const part=first[2]!.parts[0]!;
 if(part.type!=='tool-result')throw Error('missing result');
 const encoded=(part.toolResult.output as any).content;
 expect(decodeLosslessLines(encoded)).toBe(content);
 expect(JSON.stringify(first).length).toBeLessThan(content.length*.5);
 const other={...saved,revision:2,scope:{tenantId:'other'},toolResults:[{...changed,output:{...changed.output,content:content+'\nNEW_FACT'}}]};
 const next=replay(messages,other,tools)[2]!.parts[0]!;
 if(next.type!=='tool-result')throw Error('missing result');
 expect(decodeLosslessLines((next.toolResult.output as any).content)).toBe(content+'\nNEW_FACT');
 expect(JSON.stringify(first)).not.toContain('NEW_FACT');
});
test('checkpoint transport ceiling counts replay in generate and streaming routes',async()=>{
 const {createCheckpointTokenCap}=await import('../packages/core/src/runtime/runtime-policy.js');
 for(const mode of ['generate','stream'] as const){
  let dispatched=false;const base=createMockLanguageModel();
  base.generate=async()=>{dispatched=true;return{text:'bad',finishReason:'stop'};};
  base.stream=async()=>{dispatched=true;return(async function*(){})();};
  const cap=createCheckpointTokenCap({unlimitedTokens:false,maxInputTokens:1000,maxOutputTokens:1000,maxTotalTokens:2000,maxSteps:8,maxToolCalls:8,maxToolErrors:2,includeChildRuns:true},async()=>undefined);
  const model=wrapLanguageModel(wrapLanguageModel(base,[cap]),[createRequestProjection(async()=>state)]);
  const run=async()=>{if(mode==='generate')await model.generate({messages,tools});else for await(const _ of await model.stream!({messages,tools})){};};
  await expect(run()).rejects.toThrow('maxInputTokens budget exhausted');expect(dispatched).toBe(false);
 }
});
