// Installed public engine, real Docker, deterministic model; no provider credential.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHarness,runHarness} from '@zhivex-ai/harness/engine';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
const scenario=process.argv[2];
assert(['success','human-review','missing-check','snapshot-drift','scope','altered-script','stale-patch','post-check-drift','altered-test'].includes(scenario));
await writeFile('package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
const verify="const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='verified')process.exit(1);";
await writeFile('oracle.cjs',verify);
const args=scenario==='altered-test'?['oracle.cjs']:['-e',verify+(scenario==='snapshot-drift'?"require('node:fs').writeFileSync('.env','changed');":'')];
const script=scenario==='altered-script';
const command=script?'bun':'node',commandArgs=script?['--no-env-file','run','test']:args;
const requiredChecks=[{id:'content',kind:script?'package-script':'argv',command,args:commandArgs,purpose:'Verify actual candidate bytes',
  ...(script?{script:'test',expectedScript:'bun test'}:{}),execution:{backend:'oci',approval:'required',...(script?{}:{network:'none'})}}];
if(scenario==='missing-check')requiredChecks.push({id:'second',kind:'argv',command:'node',args:['--version'],purpose:'Second required check',execution:{backend:'oci',approval:'required',network:'none'}});
const contract={schemaVersion:1,taskId:scenario,allowedWritePaths:['result.txt'],protectedFiles:['package.json','oracle.cjs'],requiredChecks,
  humanReview:scenario==='human-review'?[{id:'review',requirement:'Review result',status:'pending'}]:[]};
const changes=[{path:'result.txt',expectedDigest:null,content:'verified'}];
if(scenario==='altered-test') {
  changes[0].content='incorrect';
  const {createHash}=await import('node:crypto');
  changes.push({path:'oracle.cjs',expectedDigest:'sha256:'+createHash('sha256').update(verify).digest('hex'),content:'process.exit(0);'});
}
if(scenario==='scope')changes.push({path:'outside.txt',expectedDigest:null,content:'out of scope'});
let stage=0,reviewedPatch;
const dynamic=['stale-patch','post-check-drift'].includes(scenario);
const dynamicModel=createMockLanguageModel();
const findPatch=value=>{
  if(!value || typeof value!=='object')return;
  if(value.kind==='environment-patch' && typeof value.patchId==='string')reviewedPatch=value.patchId;
  for(const nested of Object.values(value))findPatch(nested);
};
dynamicModel.stream=async input=>{
  findPatch(input.messages);
  const calls=[
    {name:'run_environment_command',input:{command:'node',args:['-e',"require('node:fs').writeFileSync('result.txt','verified')"]}},
    {name:'run_environment_command',input:{command:'node',args}},
    {name:'inspect_environment_patch',input:{}},
    {name:'run_environment_command',input:{command:'node',args:['-e',scenario==='stale-patch'?"require('node:fs').writeFileSync('result.txt','changed')":"require('node:fs').writeFileSync('.env','changed')"]}},
    {name:'apply_environment_patch',input:{patchId:reviewedPatch}}
  ];
  const call=calls[stage++];
  if(call?.name==='apply_environment_patch')assert(reviewedPatch,'Missing reviewed patch');
  return (async function*(){
    if(call)yield {type:'tool-call',toolCall:{id:'sequence-'+stage,...call}};
    else yield {type:'text-delta',textDelta:'done'};
    yield {type:'finish',finishReason:call?'tool-calls':'stop'};
  })();
};
const harness=await createHarness({workspace:process.cwd(),subagentProfiles:[],executionBackend:'oci',ociImage:'node:22-alpine',ociAllowedCommands:['node','bun'],
  modelInstance:dynamic?dynamicModel:createMockLanguageModel({streamEvents:[
    ...(script?[[{type:'tool-call',toolCall:{id:'alter-script',name:'run_environment_command',input:{command:'node',args:['-e',"require('node:fs').writeFileSync('package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'echo fabricated'}}))"]}}},{type:'finish',finishReason:'tool-calls'}]]:[]),
    [{type:'tool-call',toolCall:{id:'deliver',name:script?'run_environment_command':'verify_and_apply_reviewed_edits',input:script?{command,args:commandArgs}:{changes,command,args:commandArgs}}},{type:'finish',finishReason:'tool-calls'}],
    ...Array.from({length:6},()=>[{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}])
  ]})});
try {
  const result=await runHarness(harness,{prompt:'Deliver the contracted fixture'},{taskAcceptance:contract,
    resolveApprovals:async approvals=>approvals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}))});
  const durable=await harness.store.load(result.state.runId,harness.config.scope);
  const evidence=durable.metadata.zhivexTaskAcceptanceEvidenceV1;
  const success=['success','human-review'].includes(scenario);
  if(success) {
    assert.equal(result.status,'completed');assert.equal(await readFile('result.txt','utf8'),'verified');
    assert.equal(evidence.status,scenario==='human-review'?'pending_review':'verified');
    assert.equal(evidence.checks.length,1);assert.equal(evidence.checks[0].exitCode,0);
    assert.equal(evidence.delivery.patchId,evidence.checks[0].patchId);
  }else {
    assert.notEqual(evidence.status,'verified');assert.notEqual(evidence.status,'pending_review');
    await assert.rejects(readFile('result.txt'),{code:'ENOENT'});
    assert.equal(harness.workspace.mutationAudit().length,0);
    const diagnostic=JSON.stringify(durable.toolResults);
    assert.match(diagnostic,scenario==='stale-patch'?/changed after review/:['scope','altered-test'].includes(scenario)?/TASK_ACCEPTANCE_SCOPE_VIOLATION/:script?/script changed/:/TASK_ACCEPTANCE_CHECKS_MISSING/);
  }
  assert.equal(JSON.parse(await readFile('package.json','utf8')).scripts.test,'bun test');
  assert.equal(await readFile('oracle.cjs','utf8'),verify);
  console.log(JSON.stringify({scenario,installed:true,realDocker:true,liveProvider:false,published:false,runtime:process.version,
    status:result.status,acceptance:evidence.status,hostImported:success,runId:result.state.runId,checks:evidence.checks,delivery:evidence.delivery??null}));
}finally{await harness.close();}
