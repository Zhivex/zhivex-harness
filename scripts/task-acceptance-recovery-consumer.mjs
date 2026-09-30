import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHarness,runHarness} from '@zhivex-ai/harness/engine';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
const [phase,scenario]=process.argv.slice(2);
assert(['prepare','resume','inspect','import-crash'].includes(phase));assert(['restart','rejection','uncertain','timeout','cancellation','budget','import-crash'].includes(scenario));
const interrupted=['timeout','cancellation','budget'].includes(scenario);
const controller=new AbortController();let cancelTimer;
const args=['-e',"if(require('node:fs').readFileSync('result.txt','utf8')!=='verified')process.exit(1)"+(['timeout','cancellation'].includes(scenario)?';setTimeout(()=>{},10000)':'')];
const contract={schemaVersion:1,taskId:scenario,allowedWritePaths:['result.txt'],protectedFiles:[],humanReview:[],requiredChecks:[
  {id:'content',kind:'argv',command:'node',args,purpose:'Verify result',execution:{backend:'oci',approval:'required',network:'none'}}]};
let stage=0,patchId;
const findPatch=value=>{if(!value || typeof value!=='object')return;if(value.kind==='environment-patch')patchId=value.patchId;for(const child of Object.values(value))findPatch(child);};
const model=createMockLanguageModel();
model.stream=async input=>{
  findPatch(input.messages);
  const calls=phase==='prepare'?[
    {name:'run_environment_command',input:{command:'node',args:['-e',"require('node:fs').writeFileSync('result.txt','verified')"]}},
    {name:'run_environment_command',input:{command:'node',args}},
    {name:'inspect_environment_patch',input:{}},
    {name:'apply_environment_patch',input:{patchId}}
  ]:[];
  const call=calls[stage++];
  return (async function*(){if(call)yield {type:'tool-call',toolCall:{id:'step-'+stage,...call}};
    else yield {type:'text-delta',textDelta:'done'};yield {type:'finish',finishReason:call?'tool-calls':'stop'};})();
};
const harness=await createHarness({workspace:process.cwd(),subagentProfiles:[],executionBackend:'oci',ociImage:'node:22-alpine',ociAllowedCommands:['node','bun'],...(scenario==='timeout'?{ociMaxProcessRuntimeMs:1000}:{}),...(scenario==='budget'?{maxToolCalls:1}:{}),modelInstance:model});
const identity='../identity-'+scenario+'.json';
try {
  if(phase==='prepare') {
    const result=await runHarness(harness,{runId:'recovery-'+scenario,prompt:'Prepare verified candidate',abortSignal:controller.signal},{taskAcceptance:contract,
      resolveApprovals:async approvals=>{
        if(scenario==='cancellation' && approvals.some(a=>a.toolCallId==='step-2'))cancelTimer=setTimeout(()=>controller.abort(),500);
        if(!interrupted && approvals.some(a=>a.name==='apply_environment_patch'))return undefined;
        return approvals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}));
      }}).catch(async error=>{
        if(scenario!=='budget')throw error;
        assert.match(error.message,/budget/);
        const state=await harness.store.load('recovery-'+scenario,harness.config.scope);assert(state);
        return {state,status:state.status};
      });
    if(interrupted) {
      const state=await harness.store.load(result.state.runId,harness.config.scope),evidence=state.metadata.zhivexTaskAcceptanceEvidenceV1;
      assert.notEqual(evidence.status,'verified');assert.notEqual(evidence.status,'pending_review');
      await assert.rejects(readFile('result.txt'),{code:'ENOENT'});
      if(scenario==='cancellation')assert.equal(result.status,'cancelled');
      if(scenario==='timeout')assert(evidence.checks.some(check=>check.timedOut && check.exitCode!==0));
      if(scenario==='budget')assert.match(JSON.stringify(state),/budget|limit/i);
      await writeFile(identity,JSON.stringify({runId:state.runId,evidence,journal:await harness.store.listToolCalls(state.runId,harness.config.scope)}));
      console.log(JSON.stringify({phase,scenario,runId:state.runId,status:result.status,acceptance:evidence.status,noHostImport:true}));
    }else {
    assert.equal(result.status,'waiting_approval');
    const state=await harness.store.load(result.state.runId,harness.config.scope);
    const checks=state.metadata.zhivexTaskAcceptanceEvidenceV1.checks;assert.equal(checks.length,1);assert.equal(checks[0].exitCode,0);
    const journal=await harness.store.listToolCalls(state.runId,harness.config.scope);
    assert.equal(journal.filter(row=>row.toolName==='run_environment_command').length,2);
    if(scenario==='uncertain') {
      const original=journal.find(row=>row.providerToolCallId==='step-2');assert(original);
      // Durable fault injection: a later identical check was claimed but completion was never recorded.
      await harness.store.saveToolCall({...original,toolCallId:'interrupted-check',providerToolCallId:'interrupted-check',idempotencyKey:'interrupted-check',
        revision:0,status:'running',output:undefined,startedAt:Date.now(),completedAt:undefined,updatedAt:Date.now()});
    }
    await writeFile(identity,JSON.stringify({runId:state.runId,checks}));
    await assert.rejects(readFile('result.txt'),{code:'ENOENT'});
    console.log(JSON.stringify({phase,scenario,runId:state.runId,status:result.status,checksPreserved:true}));
    }
  }else if(phase==='import-crash') {
    const saved=JSON.parse(await readFile(identity,'utf8'));
    const before=await harness.store.load(saved.runId,harness.config.scope);
    const result=await runHarness(harness,{state:before,approvals:before.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}))});
    assert.equal(result.status,'completed');assert.equal(await readFile('result.txt','utf8'),'verified');
    const latest=await harness.store.load(saved.runId,harness.config.scope);
    const journal=await harness.store.listToolCalls(saved.runId,harness.config.scope);
    assert.equal(journal.filter(row=>row.toolName==='apply_environment_patch' && row.status==='completed').length,1);
    // Fault injection represents a crash after durable tool completion but before the run checkpoint.
    await harness.store.save({...before,revision:latest.revision},{expectedRevision:latest.revision});
    await writeFile(identity,JSON.stringify({...saved,completedImport:journal.find(row=>row.toolName==='apply_environment_patch')}));
    console.log(JSON.stringify({phase,scenario,runId:saved.runId,completedImportJournalPreserved:true}));
  }else if(phase==='inspect') {
    const saved=JSON.parse(await readFile(identity,'utf8'));
    const state=await harness.store.load(saved.runId,harness.config.scope);
    assert.deepEqual(state.metadata.zhivexTaskAcceptanceEvidenceV1,saved.evidence);
    assert.deepEqual(await harness.store.listToolCalls(saved.runId,harness.config.scope),saved.journal);
    await assert.rejects(readFile('result.txt'),{code:'ENOENT'});
    console.log(JSON.stringify({phase,scenario,runId:saved.runId,status:state.status,evidencePreserved:true,noRepeatedCommands:true}));
  }else {
    const saved=JSON.parse(await readFile(identity,'utf8'));
    const state=await harness.store.load(saved.runId,harness.config.scope);
    assert.deepEqual(state.metadata.zhivexTaskAcceptanceEvidenceV1.checks,saved.checks);
    const result=await runHarness(harness,{state,approvals:state.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:scenario!=='rejection'}))});
    const durable=await harness.store.load(saved.runId,harness.config.scope),evidence=durable.metadata.zhivexTaskAcceptanceEvidenceV1;
    const journal=await harness.store.listToolCalls(saved.runId,harness.config.scope);
    assert.equal(journal.filter(row=>row.toolName==='run_environment_command').length,scenario==='uncertain'?3:2,'Commands must not be replayed');
    if(scenario==='import-crash') {
      assert.equal(await readFile('result.txt','utf8'),'verified');assert.notEqual(evidence.status,'verified');
      assert.equal(harness.workspace.mutationAudit().length,0);
      assert.deepEqual(journal.find(row=>row.toolName==='apply_environment_patch'),saved.completedImport);
    }else if(scenario==='restart') {
      assert.equal(result.status,'completed');assert.equal(evidence.status,'verified');assert.equal(await readFile('result.txt','utf8'),'verified');
    }else {
      assert.notEqual(evidence.status,'verified');await assert.rejects(readFile('result.txt'),{code:'ENOENT'});
      if(scenario==='uncertain')assert.equal(journal.find(row=>row.toolCallId==='interrupted-check').status,'running');
    }
    console.log(JSON.stringify({phase,scenario,runId:saved.runId,status:result.status,acceptance:evidence.status,noRepeatedCommands:true}));
  }
}finally{clearTimeout(cancelTimer);await harness.close();}
