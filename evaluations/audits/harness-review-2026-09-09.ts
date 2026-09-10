/** Read-only product audit: effects are restricted to disposable local fixtures.
 * Run: bun --no-env-file run evaluations/audits/harness-review-2026-09-09.ts
 * Records observed behavior, not assertions that defects should remain permanent. */
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness, runHarness, renderHarnessInstructions } from '../../src/harness.js';
import { createEditProposal } from '../../src/edit-contracts.js';
import { compactMessages, summarizeHarnessMessages } from '../../src/compaction.js';
import { Workspace } from '../../src/workspace.js';
import { createRepairProgress } from '../../src/repair-progress.js';
import { tool } from '@zhivex-ai/core';
import { z } from 'zod';
import type { HarnessOciRuntimeAdapter, HarnessExecutionSession } from '../../src/execution-environment.js';

const evidence: Record<string, unknown> = {};
const usage={inputTokens:10,outputTokens:2,totalTokens:12};
const finish={type:'finish' as const,finishReason:'tool-calls' as const,usage};
const done=[{type:'text-delta' as const,textDelta:'done'},{...finish,finishReason:'stop' as const}];
const root=await mkdtemp(path.join(os.tmpdir(),'zhx-full-audit-'));
try {
 const task='Repair the parser. '+ 'Background detail. '.repeat(80)+'MANDATORY_ACCEPTANCE: preserve escaped delimiters.';
 const messages=[{role:'user' as const,parts:[{type:'text' as const,text:task}]}];
 const compacted=compactMessages(messages);
 evidence.compaction={originalCharacters:task.length,objectiveCharacters:JSON.parse(summarizeHarnessMessages(messages).summary).objective.length,acceptanceSurvives:JSON.stringify(compacted).includes('MANDATORY_ACCEPTANCE')};
 await writeFile(path.join(root,'value.txt'),'before\n');
 const ws=await Workspace.open(root);
 {
  const inside=path.join(root,'race-workspace'),outside=path.join(root,'race-outside');
  await mkdir(path.join(inside,'parent'),{recursive:true});await mkdir(outside);
  await writeFile(path.join(inside,'parent','fixture.txt'),'inside fixture');
  await writeFile(path.join(outside,'fixture.txt'),'outside fixture sentinel');
  const raceWorkspace=await Workspace.open(inside);
  // Deterministic scheduling of the filesystem change after ancestor validation.
  // The actual production descriptor-bound read is unchanged; no external data used.
  const schedule=raceWorkspace as unknown as {safePath:(...args:unknown[])=>Promise<unknown>};
  const original=schedule.safePath.bind(raceWorkspace);let changed=false;
  schedule.safePath=async(...args)=>{const result=await original(...args);if(!changed){changed=true;await rename(path.join(inside,'parent'),path.join(inside,'original-parent'));await symlink(outside,path.join(inside,'parent'));}return result;};
  try {const read=await raceWorkspace.readFile('parent/fixture.txt');evidence.ancestorSwap={outsideContentReturned:read.content.includes('outside fixture sentinel'),reportedPath:read.path};}
  catch(e){evidence.ancestorSwap={blocked:true,error:(e as Error).message};}
  await rm(inside,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});
 }
 try {await ws.searchFiles('before','value.txt');evidence.exactFileSearch='supported';} catch(e) {evidence.exactFileSearch=(e as Error).message;}
 evidence.exactFileSearchMany=(await ws.searchMany([{query:'before'}],'value.txt')).results[0]?.matches.length;
 await writeFile(path.join(root,'noisy.txt'),Array.from({length:501},()=> 'needle '+ 'x'.repeat(490)).join('\n'));
 evidence.searchPayloadCharacters=JSON.stringify(await ws.searchMany([{query:'needle'}],'noisy.txt',{limitPerQuery:500})).length;
 {
  const progress=createRepairProgress(()=>({inputTokens:0,outputTokens:0}),{inputTokens:100000,outputTokens:16000});
  const tools=progress.wrapTools({read_files:tool({name:'read_files',description:'fixture',schema:z.object({}),execute:async()=>({same:'data'})}),inspect_environment_patch:tool({name:'inspect_environment_patch',description:'fixture',schema:z.object({}),execute:async()=>({entries:[]})})});
  for(let i=0;i<4;i++){
   const context={toolCall:{id:`read-${i}`,name:'read_files',input:{}},step:i,model:createMockLanguageModel({streamEvents:[done]})};
   const read=tools.read_files!;if('execute' in read)await Promise.resolve(read.execute({},context)).catch(error=>{if(!String(error).includes('REPEATED_EXPLORATION'))throw error;});
   const inspect=tools.inspect_environment_patch!;if('execute' in inspect)await inspect.execute({},context);
  }
  evidence.readOnlyInspectionResetsDuplicateTracking={identicalReads:4,...progress.stats};
 }
 await writeFile(path.join(root,'large.txt'),'unique-large-file-marker '+ 'x'.repeat(1024*1024));
 evidence.skippedSearch=await ws.searchMany([{query:'unique-large-file-marker'}]);
 await rm(path.join(root,'large.txt'));
 {
  let requests=0;
  const model=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'write',name:'apply_reviewed_edits',input:{changes:[{path:'created.txt',expectedDigest:null,content:'approved\n'}]}}},finish],done]});
  const stream=model.stream!;model.stream=async input=>{requests++;return stream(input);};
  const h=await createHarness({workspace:root,provider:'openai',modelInstance:model,store:createInMemoryAgentRunStore(),maxSteps:5});
  try {const result=await runHarness(h,{prompt:'Create the fixture.',maxSteps:1},{resolveApprovals:async pending=>pending.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}))});evidence.maxStepsContinuation={requestedMaxSteps:1,modelRequests:requests,status:result.status};}finally{await h.close();}
 }
 {
  const abort=new AbortController();let executions=0;let signalPresent=false;
  const runtime:HarnessOciRuntimeAdapter={async inspectImage(imageReference){return {runtime:'docker',runtimeVersion:'fixture',imageReference,imageId:`sha256:${'a'.repeat(64)}`,imageDigest:`sha256:${'a'.repeat(64)}`};},async run(request){executions++;signalPresent=!!request.abortSignal;return {command:request.command,exitCode:0,stdout:'',stderr:'',timedOut:false,cancelled:false,outputLimitExceeded:false};},async removeRunContainers(){return 0;},async cleanupOrphans(){return 0;}};
  const input={patchId:`sha256:${'0'.repeat(64)}`,command:'node',args:['verify.mjs']};
  const model=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'verify',name:'verify_and_apply_environment_patch',input}},finish]]});
  const h=await createHarness({workspace:root,executionBackend:'oci',provider:'openai',modelInstance:model,store:createInMemoryAgentRunStore(),ociRuntimeAdapter:runtime,ociAllowedCommands:['node','bun'],maxSteps:3});
  try {
   const session=await h.executionEnvironment!.acquire({runId:'cancel-terminal'}) as HarnessExecutionSession;
   const before=await session.workspace.readFile('value.txt');
   const changes=[{path:'value.txt',expectedDigest:before.digest,content:'after\n'}];
   await session.workspace.applyPatch({proposalId:createEditProposal({changes}).proposalId,changes});
   input.patchId=(await session.inspectPatch()).patchId;
   const auditBefore=session.workspace.mutationAudit().length;
   await session.release?.({status:'waiting_approval'});
   const reacquired=await h.executionEnvironment!.acquire({runId:'cancel-terminal'}) as HarnessExecutionSession;
   evidence.ociMutationAudit={beforeReacquire:auditBefore,afterReacquire:reacquired.workspace.mutationAudit().length,patchEntries:(await reacquired.inspectPatch()).entries.length};
   const result=await runHarness(h,{runId:'cancel-terminal',prompt:'Verify fixture.',abortSignal:abort.signal},{terminalReceiptTools:['verify_and_apply_environment_patch'],resolveApprovals:async pending=>{abort.abort(new Error('operator cancelled fixture'));return pending.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}));}}).catch(e=>({status:'threw',error:(e as Error).message}));
   evidence.terminalCancellation={status:result.status,aborted:abort.signal.aborted,executions,signalPresent,hostImported:(await readFile(path.join(root,'value.txt'),'utf8'))==='after\n'};
  } finally {await h.close();}
 }
 const selected=['list_files','read_files','search_many','apply_reviewed_replacement','apply_reviewed_edits','run_environment_shell','run_environment_command','inspect_environment_patch','verify_and_apply_environment_patch'];
 evidence.absentButInstructedTools=['mutation_audit','git_diff','load_skill','apply_patch','run_check'].filter(n=>renderHarnessInstructions(selected).includes(n)&&!selected.includes(n));
 console.log(JSON.stringify({schemaVersion:1,audit:'harness-review-2026-09-09',evidence},null,2));
}finally{await rm(root,{recursive:true,force:true});}
