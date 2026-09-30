// Public installed engine/client, real local Docker, fixture model.
import assert from 'node:assert/strict';
import { createHarness, inspectHarnessPolicy } from '@zhivex-ai/harness/engine';
import { createHarnessClientAdapter } from '@zhivex-ai/harness/client';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
const harness=await createHarness({ workspace:process.cwd(),subagentProfiles:[],executionBackend:'oci',ociImage:'node:22-alpine',ociAllowedCommands:['node','bun'],
  modelInstance:createMockLanguageModel({streamEvents:[[
    {type:'tool-call',toolCall:{id:'real-oci-version',name:'run_environment_command',input:{command:'node',args:['--version']}}},
    {type:'finish',finishReason:'tool-calls'}
  ],[{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}]]}) });
const adapter=await createHarnessClientAdapter(harness);
const hello=adapter.negotiate([1]); assert(hello.ok); let seq=0;
const call=async command=>{
  const result=await adapter.dispatch({protocolVersion:1,requestId:String(++seq),connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
  assert(result.ok,JSON.stringify(result)); return result.data;
};
try {
  const view=inspectHarnessPolicy(harness);
  assert.deepEqual(view.execution,{configuredBackend:'oci',activeBackend:'oci',evidence:'configuration-only'});
  assert.deepEqual((await call({method:'policy.get'})).policy,view);
  assert.deepEqual((await call({method:'session.list'})).sessions,[]);
  const {session}=await call({method:'session.create',idempotencyKey:'create'});
  const {run:pending}=await call({method:'run.start',sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:'start',prompt:'Report isolated Node version'});
  assert.equal(pending.status,'waiting_approval');
  assert(pending.cliResult.policyEvidence.events.some(e=>e.phase==='approval-request'&&e.executionBackend==='oci'));
  const {run:complete}=await call({method:'approval.resolve',sessionId:session.sessionId,runId:pending.runId,expectedRevision:pending.revision,idempotencyKey:'approve',
    decisions:pending.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))});
  assert.equal(complete.status,'completed');
  assert(complete.cliResult.policyEvidence.events.some(e=>e.phase==='tool-entry'&&e.executionBackend==='oci'&&e.evidence==='policy-evaluation'));
  const state=await harness.store.load(pending.runId,harness.config.scope);
  assert.match(JSON.stringify(state.toolResults),/v22\./);
  assert.equal(harness.workspace.mutationAudit().length,0);
  assert.deepEqual(inspectHarnessPolicy(harness),view);
  console.log(JSON.stringify({schemaVersion:1,installed:true,realDocker:true,liveProvider:false,published:false,queryConfigurationOnly:true,pendingOci:true,toolEntryOci:true,commandOutputVerified:true,runtime:process.version}));
} finally {adapter.close();await harness.close();}
