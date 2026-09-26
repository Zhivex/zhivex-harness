import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness, runHarness } from '../src/runtime/harness.js';
const finish={type:'finish' as const,finishReason:'tool-calls' as const,usage:{inputTokens:10,outputTokens:2,totalTokens:12}};
const unknown=(id:string)=>[{type:'tool-call' as const,toolCall:{id,name:'unregistered_fixture',input:{}}},finish];
for(const scenario of ['repair','strict','override','bounded'] as const)test(`unknown tool selection: ${scenario}`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'repair-tool-selection-'));let h;
 try{
  await writeFile(path.join(root,'value.txt'),'known fixture');const store=createInMemoryAgentRunStore();
  h=await createHarness({workspace:root,agentProfile:scenario==='strict'?'strict':'repair',store,maxToolErrors:scenario==='bounded'?1:4,
   modelInstance:createMockLanguageModel({streamEvents:scenario==='bounded'?[unknown('bad1'),unknown('bad2'),unknown('bad3')]:[
    unknown('bad'),[{type:'tool-call',toolCall:{id:'read',name:'read_file',input:{path:'value.txt'}}},finish],
    [{type:'text-delta',textDelta:'Inspected fixture'},{...finish,finishReason:'stop'}]
   ]})});
  const pending=runHarness(h,{runId:'selection',prompt:'Inspect value.txt.',...(scenario==='override'?{toolExecution:{unknownToolMode:'throw' as const}}:{})});
   if(scenario==='override')await expect(pending).rejects.toThrow('not registered');
  else if(scenario==='bounded'){
   await pending.catch(()=>undefined);const saved=await store.load('selection');
   expect(saved?.status).toBe('failed');expect(saved!.steps.length).toBeLessThanOrEqual(2);
  }else{
   const result=await pending;expect(result.status).toBe('completed');
   expect(result.toolResults[0]).toMatchObject({toolName:'unregistered_fixture',isError:true,error:{code:'TOOL_NOT_REGISTERED'}});
   expect(result.toolResults.filter(r=>!r.isError)).toHaveLength(1);
   expect(result.toolResults.find(r=>r.toolName==='read_file')?.isError).toBe(false);
   expect(result.usage?.inputTokens).toBe(30);
  }
 }finally{await h?.close();await rm(root,{recursive:true,force:true});}
});

test('recovering an unknown selection does not approve the next mutation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'repair-selection-approval-'));let h;
 try{
  await writeFile(path.join(root,'value.txt'),'before');
  const {createHash}=await import('node:crypto');
  h=await createHarness({workspace:root,agentProfile:'repair',modelInstance:createMockLanguageModel({streamEvents:[unknown('bad'),[
   {type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'value.txt',expectedDigest:'sha256:'+createHash('sha256').update('before').digest('hex'),oldText:'before',newText:'after'}}},finish
  ]]})});
  const result=await runHarness(h,{prompt:'Replace before with after.'});
  expect(result.status).toBe('waiting_approval');
  expect(result.state.pendingApprovals[0]?.name).toBe('apply_reviewed_replacement');
  expect(await Bun.file(path.join(root,'value.txt')).text()).toBe('before');
 }finally{await h?.close();await rm(root,{recursive:true,force:true});}
});
