import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createTextMessage } from '@zhivex-ai/core';
import { createHarness,runHarness,taskAcceptanceContractSchema,compileTaskAcceptanceContract,inspectHarnessTaskAcceptance,reviseHarnessTaskAcceptance } from '@zhivex-ai/harness/engine';
const phase=process.argv[2];assert(['prepare','resume'].includes(phase));
const contract=taskAcceptanceContractSchema.parse({schemaVersion:1,taskId:'installed-edit',allowedWritePaths:['result.txt'],protectedFiles:['package.json'],
  requiredChecks:[{id:'test',kind:'package-script',script:'test',expectedScript:'bun test',command:'bun',args:['--no-env-file','run','test'],purpose:'Tests',execution:{backend:'none',approval:'required'}}],
  humanReview:[{id:'review',requirement:'Review behavior',status:'pending'}]});
if(phase==='prepare')await writeFile('package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
const model=createMockLanguageModel({streamEvents:phase==='prepare'?[[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_edits',input:{changes:[{path:'result.txt',expectedDigest:null,content:'not approved'}]}}},{type:'finish',finishReason:'tool-calls'}]]:[[{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}]]});
const harness=await createHarness({workspace:process.cwd(),subagentProfiles:[],modelInstance:model,compactionMaxMessages:4,compactionKeepRecentMessages:2});
try {
  if(phase==='prepare') {
    const result=await runHarness(harness,{messages:[createTextMessage('user','Edit result.txt'),createTextMessage('assistant','Old analysis. '.repeat(2000)),createTextMessage('user','Preserve requirements'),createTextMessage('assistant','Inspect first'),createTextMessage('user','Continue')]},{taskAcceptance:contract});
    assert.equal(result.status,'waiting_approval');assert(result.state.compactions.length>0);
    const ledger=await inspectHarnessTaskAcceptance(harness,result.state.runId);
    assert.equal(ledger.revisions[0].digest,compileTaskAcceptanceContract(contract).digest);
    await writeFile('identity.json',JSON.stringify({runId:result.state.runId,ledger}));
    await assert.rejects(readFile('result.txt'));
  } else {
    const saved=JSON.parse(await readFile('identity.json','utf8'));
    assert.deepEqual(await inspectHarnessTaskAcceptance(harness,saved.runId),saved.ledger);
    const stale=await harness.store.load(saved.runId,harness.config.scope);
    const revised=await reviseHarnessTaskAcceptance(harness,{runId:saved.runId,expectedRunRevision:stale.revision,expectedContractRevision:1,
      contract:{...contract,humanReview:[{id:'review',requirement:'Review revised requirements',status:'pending'}]}});
    assert.equal(revised.revisions.length,2);
    await assert.rejects(runHarness(harness,{state:stale}),/REVISION_CONFLICT/);
    const current=await harness.store.load(saved.runId,harness.config.scope);
    const result=await runHarness(harness,{state:current,approvals:current.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:false}))});
    assert.equal(result.status,'completed');
    assert.deepEqual(await inspectHarnessTaskAcceptance(harness,saved.runId),revised);
    await assert.rejects(readFile('result.txt'));
  }
}finally{await harness.close();}
console.log(JSON.stringify({phase,ok:true,runtime:process.version,installed:true,fixture:true,liveProvider:false}));
