import { expect, test } from 'bun:test';
import { wrapLanguageModel, createTextMessage } from '@zhivex-ai/core';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createPilotBudget } from '../scripts/acceptance/pilot-budget.js';
const limits={timeoutMs:150000,maxInputTokens:60000,maxOutputTokens:20,maxTotalTokens:60020,maxSteps:3,maxToolCalls:2};
const response=(outputTokens=8)=>({text:'done',messages:[createTextMessage('assistant','done')],usage:{inputTokens:10,outputTokens},finishReason:'stop' as const});
test('a meter bounds all runs in a case, not each reopened model',async()=>{
 const meter=createPilotBudget(limits);const base=createMockLanguageModel({responses:[response(),response(),response()]});
 const call=()=>wrapLanguageModel(base,[meter.middleware]).generate({messages:[createTextMessage('user','task')]});
 await call();await call();await expect(call()).rejects.toThrow('PILOT_BUDGET_EXHAUSTED');
 expect(meter.snapshot()).toMatchObject({steps:3,inputTokens:30,outputTokens:24,usageComplete:true});
});
test('unknown usage refuses the next provider call and never becomes zero cost',async()=>{
 const meter=createPilotBudget(limits);const base=createMockLanguageModel({responses:[{text:'done',messages:[],finishReason:'stop'}]});
 const model=wrapLanguageModel(base,[meter.middleware]);
 await expect(model.generate({messages:[]})).rejects.toThrow('PILOT_USAGE_UNKNOWN');
 expect(meter.stats.usageComplete).toBe(false);
 await expect(model.generate({messages:[]})).rejects.toThrow('PILOT_USAGE_UNKNOWN');expect(meter.stats.steps).toBe(1);
});
test('aggregate step and deadline ceilings stop admission',async()=>{
 let time=0;const meter=createPilotBudget({...limits,maxSteps:1},()=>time);
 const model=wrapLanguageModel(createMockLanguageModel({responses:[response()]}),[meter.middleware]);
 await model.generate({messages:[]});await expect(model.generate({messages:[]})).rejects.toThrow('PILOT_BUDGET_EXHAUSTED');
 time=150000;expect(meter.remainingMs()).toBe(0);expect(meter.check).toThrow('PILOT_BUDGET_EXHAUSTED');
});

test('streaming counts requested calls and refuses an over-limit batch',async()=>{
 const meter=createPilotBudget({...limits,maxToolCalls:1});
 const base=createMockLanguageModel({streamEvents:[[
  {type:'tool-call',toolCall:{id:'a',name:'read',input:{}}},
  {type:'tool-call',toolCall:{id:'b',name:'read',input:{}}},
  {type:'finish',usage:{inputTokens:10,outputTokens:5},finishReason:'tool-calls'}
 ]]});
 const model=wrapLanguageModel(base,[meter.middleware]);
 await expect((async()=>{for await(const _event of await model.stream!({messages:[]})){} })()).rejects.toThrow('PILOT_BUDGET_EXHAUSTED');
 expect(meter.stats).toMatchObject({toolCalls:2,budgetExhausted:true,usageComplete:false});
});

test('request diagnostics separate context estimates, reported use, cache and rejected admission without retaining content', async () => {
 const meter=createPilotBudget({...limits,maxSteps:1});
 const base=createMockLanguageModel({responses:[{...response(),usage:{inputTokens:10,outputTokens:8,cachedInputTokens:4}}]});
 const model=wrapLanguageModel(base,[meter.middleware]);
 const messages=[createTextMessage('system','private-system'),createTextMessage('user','private-user')];
 await model.generate({messages});await expect(model.generate({messages})).rejects.toThrow('PILOT_BUDGET_EXHAUSTED');
 const measurements=meter.snapshot().requests;
 expect(measurements).toHaveLength(2);
 expect(measurements[0]).toMatchObject({admitted:true,completed:true,inputTokens:10,outputTokens:8,cachedInputTokens:4});
 expect(measurements[0]!.context.systemCharacters).toBeGreaterThan(0);
 expect(measurements[1]).toMatchObject({admitted:false,completed:false,inputTokens:null});
 expect(JSON.stringify(measurements)).not.toContain('private-');
 measurements[0]!.inputTokens=999;expect(meter.snapshot().requests[0]!.inputTokens).toBe(10);
});
