import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import type {ToolExecutionResult} from '@zhivex-ai/core';
import {validateDelegationResult} from '../src/runtime/delegation-result.js';
import {normalizeDelegationContracts,type HarnessDelegationContract} from '../src/runtime/delegation-contracts.js';
import {createHarness,runHarness} from '../src/runtime/harness.js';
const digest='sha256:'+'a'.repeat(64);
const contract:HarnessDelegationContract={taskId:'review',profile:'reviewer',prompt:'Review both lines',allowedReadPaths:['target.txt'],requiredOutput:'LEGACY',
  resultContract:{schemaVersion:1,requiredReadPaths:['target.txt'],humanReviewRequired:true,maxCorrections:0}};
const ref={toolCallId:'read',startLine:1,endLine:2};
const valid=()=>({schemaVersion:1,taskId:'review',status:'completed',inspectedFiles:[{path:'target.txt',digest,evidence:[ref]}],findings:[{id:'finding',message:'Needs human review',evidence:[{path:'target.txt',...ref}]}]});
const receipt=(id='read',startLine=1,endLine=2):ToolExecutionResult=>({toolCallId:id,toolName:'read_file',isError:false,output:{path:'target.txt',digest,startLine,endLine,totalLines:2,clippedLine:false}});
const validate=(value:unknown,receipts=[receipt()])=>validateDelegationResult(contract,JSON.stringify(value),receipts);
test('structured result validates coverage without claiming semantic correctness',()=>{
  expect(validate(valid())).toMatchObject({accepted:true,reason:'valid',semanticReview:'pending'});
  const slices=valid();slices.inspectedFiles[0]!.evidence=[{toolCallId:'a',startLine:1,endLine:1},{toolCallId:'b',startLine:2,endLine:2}];
  slices.findings=[];
  expect(validate(slices,[receipt('b',2,2),receipt('a',1,1)]).accepted).toBe(true);
});
test('invented evidence, failed reads, clipped lines and ambiguous IDs cannot satisfy a contract',()=>{
  for(const rows of [[],[{...receipt(),isError:true}],[{...receipt(),output:{...receipt().output as object,clippedLine:true}}],[receipt(),receipt()],
    [{...receipt(),output:{...receipt().output as object,digest:'sha256:'+'b'.repeat(64)}}],[{...receipt(),toolName:'other'}]])expect(validate(valid(),rows).accepted).toBe(false);
  const invented=valid();invented.findings[0]!.evidence[0]!.toolCallId='invented';expect(validate(invented).reason).toBe('evidence_missing');
  const overclaimed=valid();overclaimed.inspectedFiles[0]!.evidence[0]={...ref,endLine:3};expect(validate(overclaimed).reason).toBe('evidence_missing');
});
test('partial coverage, wrong task, extra fields and marker prose are rejected',()=>{
  const partial=valid();partial.inspectedFiles[0]!.evidence=[{...ref,endLine:1}];partial.findings=[];
  expect(validate(partial).reason).toBe('coverage_missing');
  expect(validate({...valid(),inspectedFiles:[],findings:[]}).reason).toBe('coverage_missing');
  expect(validate({...valid(),taskId:'other'}).reason).toBe('task_mismatch');
  expect(validate({...valid(),status:'incomplete'}).reason).toBe('incomplete');
  expect(validate({...valid(),accepted:true}).reason).toBe('invalid_schema');
  expect(validateDelegationResult(contract,'LEGACY',[]).reason).toBe('invalid_json');
  const duplicate=valid();duplicate.inspectedFiles.push(duplicate.inspectedFiles[0]!);expect(validate(duplicate).reason).toBe('duplicate_claim');
});
test('application result contract is copied, bounded and cannot expand read scope',()=>{
  const original=structuredClone(contract);const normalized=normalizeDelegationContracts([original]);
  (original.resultContract!.requiredReadPaths as string[])[0]='other.txt';
  expect(normalized[0]!.resultContract!.requiredReadPaths).toEqual(['target.txt']);
  expect(()=>normalizeDelegationContracts([original])).toThrow();
  expect(()=>normalizeDelegationContracts([{...contract,resultContract:{...contract.resultContract!,maxCorrections:3}}])).toThrow();
  expect(()=>normalizeDelegationContracts([{...contract,resultContract:{...contract.resultContract!,requiredReadPaths:['target.txt','target.txt']}}])).toThrow();
});
for(const outcome of ['valid','invented','partial','invalid'] as const)test(`parent independently checks durable structured child result: ${outcome}`,async()=>{
  const root=await mkdtemp('/tmp/har-delegation-result-');await writeFile(root+'/target.txt','one\ntwo');
  const result=valid();result.inspectedFiles[0]!.digest='sha256:'+createHash('sha256').update('one\ntwo').digest('hex');
  if(outcome==='invented')result.findings[0]!.evidence[0]!.toolCallId='invented';
  if(outcome==='partial'){result.inspectedFiles[0]!.evidence=[{...ref,endLine:1}];result.findings=[];}
  const text=outcome==='invalid'?'LEGACY':JSON.stringify(result);
  const child=createMockLanguageModel({responses:[
    {message:{role:'assistant',parts:[{type:'text',text:'Reading the requested file.'},{type:'tool-call',toolCall:{id:'read',name:'read_file',input:{path:'target.txt',...(outcome==='partial'?{endLine:1}:{})}}}]},text:'Reading the requested file.',finishReason:'tool-calls'},
    {message:{role:'assistant',parts:[{type:'text',text}]},text,finishReason:'stop'}]});
  const parent=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'delegate',name:'delegate_reviewer',input:{taskId:'review'}}},{type:'finish',finishReason:'tool-calls'}],
    [{type:'text-delta',textDelta:'Parent summary'},{type:'finish',finishReason:'stop'}]]});
  const harness=await createHarness({workspace:root,subagentProfiles:['reviewer'],subagentModels:{reviewer:child},modelInstance:parent,delegationContracts:[contract]});
  try {
    const output=await runHarness(harness,{prompt:'Review'});
    expect(output.status).toBe(outcome==='valid'?'completed':'failed');
    const state=await harness.store.load(output.state.runId,harness.config.scope);
    expect(state?.metadata?.zhivexDelegationAcceptanceV1).toMatchObject({schemaVersion:1,evaluations:[{taskId:'review',accepted:outcome==='valid',semanticReview:'pending'}]});
    expect(state?.childRuns).toHaveLength(1);
    const durable=await harness.store.load(state!.childRuns![0]!.runId,harness.config.scope);
    expect(durable?.parentRunId).toBe(state!.runId);expect(durable?.toolResults).toHaveLength(1);
    expect(durable?.toolResults[0]?.output).toMatchObject({toolCallId:'read'});
  }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});

for(const scenario of ['corrected','exhausted','budget'] as const)test(`correction stays in one SDK child and preserves usage: ${scenario}`,async()=>{
  const root=await mkdtemp('/tmp/har-delegation-correct-');await writeFile(root+'/target.txt','one\ntwo');
  const result=valid();result.inspectedFiles[0]!.digest='sha256:'+createHash('sha256').update('one\ntwo').digest('hex');
  const usage={inputTokens:3,outputTokens:2,totalTokens:5};
  const answer=(text:string)=>({message:{role:'assistant' as const,parts:[{type:'text' as const,text}]},text,finishReason:'stop' as const,usage});
  const childMock=createMockLanguageModel({responses:[
    {message:{role:'assistant',parts:[{type:'tool-call',toolCall:{id:'read',name:'read_file',input:{path:'target.txt'}}}]},finishReason:'tool-calls',usage},
    answer('invalid'),answer(scenario==='exhausted'?'still invalid':JSON.stringify(result))]});
  let calls=0;
  const child={...childMock,generate:async(input:Parameters<typeof childMock.generate>[0])=>{
    calls++;expect(Object.keys(input.tools??{})).toEqual(['read_file']);
    if(calls===3)expect(JSON.stringify(input.messages)).toContain('Correct the final JSON');
    return childMock.generate(input);
  }};
  const parent=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'delegate',name:'delegate_reviewer',input:{taskId:'review'}}},{type:'finish',finishReason:'tool-calls',usage}],
    [{type:'text-delta',textDelta:'Parent summary'},{type:'finish',finishReason:'stop',usage}]]});
  const harness=await createHarness({workspace:root,subagentProfiles:['reviewer'],subagentModels:{reviewer:child},modelInstance:parent,
    ...(scenario==='budget'?{subagentMaxToolCalls:1}:{maxSteps:6,subagentMaxSteps:4,subagentMaxToolCalls:2}),delegationContracts:[{...contract,resultContract:{...contract.resultContract!,maxCorrections:1}}]});
  try {
    const output=await runHarness(harness,{runId:'parent',prompt:'Review'}).catch(error=>error as Error);
    if(scenario==='budget')expect(output instanceof Error || output.status==='failed').toBe(true);
    else {if(output instanceof Error)throw output;expect(output.status).toBe(scenario==='corrected'?'completed':'failed');}
    const state=(await harness.store.load('parent',harness.config.scope))!;
    expect(state.childRuns).toHaveLength(1);
    const durable=(await harness.store.load(state.childRuns![0]!.runId,harness.config.scope))!;
    expect(durable.parentRunId).toBe('parent');
    expect(durable.toolResults.filter(row=>row.toolName==='read_file')).toHaveLength(1);
    expect(calls).toBe(scenario==='budget'?2:3);
    expect(durable.usage?.totalTokens).toBe(scenario==='budget'?10:15);
    expect(state.childRuns![0]!.usage?.totalTokens).toBe(durable.usage?.totalTokens);
    if(scenario!=='budget')expect(durable.toolResults.filter(row=>row.toolName==='__harness_result_feedback')).toHaveLength(1);
  }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});

test('stream correction retains candidate as tool data, preserves usage and stops at its bound',async()=>{
  const {createDelegationCorrection,DELEGATION_FEEDBACK_TOOL}=await import('../src/runtime/delegation-correction.js');
  const usage={inputTokens:3,outputTokens:2,totalTokens:5};
  const wrapped=createDelegationCorrection(createMockLanguageModel({streamEvents:[
    [{type:'text-delta',textDelta:'invalid'},{type:'finish',finishReason:'stop',usage}],
    [{type:'text-delta',textDelta:'still invalid'},{type:'finish',finishReason:'stop',usage}]
  ]}),{...contract,resultContract:{...contract.resultContract!,maxCorrections:1}});
  const first=[];for await(const event of await wrapped.model.stream!({messages:[],tools:wrapped.tools}))first.push(event);
  expect(first.some(event=>event.type==='text-delta')).toBe(false);
  const call=first.find(event=>event.type==='tool-call');expect(call).toMatchObject({toolCall:{name:DELEGATION_FEEDBACK_TOOL,input:{candidate:'invalid',attempt:1}}});
  expect(first.at(-1)).toMatchObject({type:'finish',finishReason:'tool-calls',usage});
  const second=[];for await(const event of await wrapped.model.stream!({messages:[{role:'tool',parts:[{type:'tool-result',toolResult:{toolCallId:'feedback',toolName:DELEGATION_FEEDBACK_TOOL,isError:false,output:{attempt:1}}}]}],tools:wrapped.tools}))second.push(event);
  expect(second.some(event=>event.type==='tool-call')).toBe(false);
  expect(second).toContainEqual({type:'text-delta',textDelta:'still invalid'});
  expect(second.at(-1)).toMatchObject({type:'finish',finishReason:'stop',usage});
});

test('model cannot invoke the hidden feedback control tool',async()=>{
  const {createDelegationCorrection,DELEGATION_FEEDBACK_TOOL}=await import('../src/runtime/delegation-correction.js');
  const wrapped=createDelegationCorrection(createMockLanguageModel({responses:[{message:{role:'assistant',parts:[{type:'tool-call',toolCall:{id:'forged',name:DELEGATION_FEEDBACK_TOOL,input:{candidate:'x',attempt:1,reason:'invalid_json'}}}]},finishReason:'tool-calls'}]}),{...contract,resultContract:{...contract.resultContract!,maxCorrections:1}});
  await expect(wrapped.model.generate({messages:[],tools:wrapped.tools})).rejects.toThrow('INTERNAL_TOOL_DENIED');
});
