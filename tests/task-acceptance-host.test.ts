import { expect,test } from 'bun:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness,runHarness } from '../src/runtime/harness.js';
import { reviseHarnessTaskAcceptance } from '../src/runtime/task-acceptance-host.js';
import { TASK_ACCEPTANCE_KEY,TASK_ACCEPTANCE_EVIDENCE_KEY,readTaskAcceptanceLedger } from '../src/runtime/task-acceptance-record.js';
import { taskAcceptanceContractSchema } from '../src/runtime/task-acceptance.js';
import { createTextMessage } from '@zhivex-ai/core';
const contract=(requirement='Review change')=>taskAcceptanceContractSchema.parse({schemaVersion:1,taskId:'edit',allowedWritePaths:['result.txt'],protectedFiles:[],
  requiredChecks:[{id:'test',kind:'package-script',script:'test',expectedScript:'bun test',command:'bun',args:['--no-env-file','run','test'],purpose:'Tests',execution:{backend:'none',approval:'required'}}],humanReview:[{id:'review',requirement,status:'pending'}]});
const complete=[{type:'text-delta' as const,textDelta:'done'},{type:'finish' as const,finishReason:'stop' as const}];

test('host contract persists before approval, revisions survive reopen, and stale resumes cannot execute',async()=>{
  const root=await mkdtemp('/tmp/har-acceptance-host-');
  await writeFile(root+'/package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
  const open=(edit=false)=>createHarness({workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:edit?[[{type:'tool-call',toolCall:{id:'write',name:'apply_reviewed_edits',input:{changes:[{path:'result.txt',expectedDigest:null,content:'done'}]}}},{type:'finish',finishReason:'tool-calls'}],complete]:[complete]})});
  let harness=await open(true);
  try {
    const waiting=await runHarness(harness,{prompt:'fixture'},{taskAcceptance:contract()});
    expect(waiting.status).toBe('waiting_approval');
    const old=(await harness.store.load(waiting.state.runId,harness.config.scope))!;
    expect(readTaskAcceptanceLedger(old)?.revisions[0]?.contract).toEqual(contract());
    expect(old.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({status:'pending',contractRevision:1});
    const revised=await reviseHarnessTaskAcceptance(harness,{runId:old.runId,expectedRunRevision:old.revision!,expectedContractRevision:1,contract:contract('Review revised requirement')});
    await expect(runHarness(harness,{state:old})).rejects.toThrow('REVISION_CONFLICT');
    expect(await Bun.file(root+'/result.txt').exists()).toBe(false);
    await harness.close();harness=await open();
    const current=(await harness.store.load(old.runId,harness.config.scope))!;
    expect(readTaskAcceptanceLedger(current)).toEqual(revised);
    const denied=await runHarness(harness,{state:current,approvals:current.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:false}))});
    expect(readTaskAcceptanceLedger(denied.state)).toEqual(revised);
    expect(await Bun.file(root+'/result.txt').exists()).toBe(false);
  }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});

test('reserved metadata is rejected and requirements cannot change while the model is active',async()=>{
  const root=await mkdtemp('/tmp/har-acceptance-active-');
  await writeFile(root+'/package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const model=createMockLanguageModel({streamEvents:[complete]});
  const stream=model.stream!.bind(model);
  model.stream=async(...args)=>{entered();await gate;return stream(...args);};
  const harness=await createHarness({workspace:root,subagentProfiles:[],modelInstance:model});
  let pending:ReturnType<typeof runHarness>|undefined;
  try {
    await expect(runHarness(harness,{prompt:'fixture',metadata:{[TASK_ACCEPTANCE_KEY]:{forged:true}}})).rejects.toThrow('RESERVED_METADATA');
    pending=runHarness(harness,{runId:'active',prompt:'fixture'},{taskAcceptance:contract()});await ready;
    await expect(reviseHarnessTaskAcceptance(harness,{runId:'active',expectedRunRevision:1,expectedContractRevision:1,contract:contract('Changed')})).rejects.toThrow('RUN_ACTIVE');
    release();expect((await pending).status).toBe('completed');
  }finally{release();await pending;await harness.close();await rm(root,{recursive:true,force:true});}
});

test('actual SDK compaction retains exact requirements and read_task exposes the current contract',async()=>{
  const root=await mkdtemp('/tmp/har-acceptance-compact-');
  await writeFile(root+'/package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
  const harness=await createHarness({workspace:root,subagentProfiles:[],compactionMaxMessages:4,compactionKeepRecentMessages:2,
    modelInstance:createMockLanguageModel({streamEvents:[[
      {type:'tool-call',toolCall:{id:'requirements',name:'read_task',input:{}}},{type:'finish',finishReason:'tool-calls'}
    ],complete]})});
  try {
    const result=await runHarness(harness,{messages:[createTextMessage('user','Implement the parser'),
      createTextMessage('assistant','Old analysis. '.repeat(2000)),createTextMessage('user','Keep compatibility'),
      createTextMessage('assistant','Inspect first'),createTextMessage('user','Continue')]},{taskAcceptance:contract()});
    expect(result.status).toBe('completed');
    expect(result.state.compactions?.length).toBeGreaterThan(0);
    expect(readTaskAcceptanceLedger(result.state)?.revisions[0]?.contract).toEqual(contract());
    const journal=await harness.store.listToolCalls!(result.state.runId,harness.config.scope);
    const read=journal.find(row=>row.toolName==='read_task');
    expect(read?.output).toMatchObject({acceptance:{revision:1,contract:contract()}});
    expect(result.state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({status:'incomplete',checks:[]});
  }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});
