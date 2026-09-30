// Executed from an isolated package installation, in separate prepare/verify processes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHarness, inspectHarnessPolicy } from '@zhivex-ai/harness/engine';
import { startHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService } from '@zhivex-ai/harness/service';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';

const phase = process.argv[2]; assert(['prepare','verify'].includes(phase));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = path.resolve('..'), policyFile = path.join(root,'policy.json');
if (phase === 'prepare') await writeFile(policyFile, JSON.stringify({ schemaVersion:1, rules:[{
  id:'deny-read', tools:['read_file'], decision:'deny', reason:'Restricted /private/customer/data sk-fixturesecret123'
}] }), { mode:0o600 });
let modelCalls = 0;
const model = createMockLanguageModel({ streamEvents:[[
  {type:'tool-call',toolCall:{id:'read',name:'read_file',input:{path:'private.txt'}}}, {type:'finish',finishReason:'tool-calls'}
], [{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}]] });
const stream = model.stream.bind(model);
model.stream = async (...args) => { modelCalls++; assert.equal(phase,'prepare'); return stream(...args); };
const harness = await createHarness({ workspace:process.cwd(), stateDirectory:path.join(root,'state'), subagentProfiles:[], toolPolicyFile:policyFile, modelInstance:model });
const service = await startHarnessLocalService(harness,{directory:path.join(root,'socket')});
const credentials = await readHarnessLocalCredentials(service.credentialsPath);
const hello = await requestHarnessLocalService(credentials,'hello',{versions:[1]}); assert(hello.ok);
let seq=0;
const call = async command => {
  const result=await requestHarnessLocalService(credentials,'command',{protocolVersion:1,requestId:`${phase}-${++seq}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
  assert(result.ok,JSON.stringify(result)); return result.data;
};
const cli = path.join(root,'node_modules/@zhivex-ai/harness/dist/cli.js');
async function queryCli(args) {
  const child=spawn(process.execPath,['--import',path.join(root,'no-network.mjs'),cli,'policy',...args,'--json'],{
    env:{PATH:process.env.PATH,HOME:root,OPENAI_API_KEY:'fixture-only',ZHIVEX_HARNESS_CREDENTIAL_STORE:'disabled'},stdio:['ignore','pipe','pipe']});
  let output='',error=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>error+=c);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,error); return JSON.parse(output);
}
try {
  const view=inspectHarnessPolicy(harness);
  assert.deepEqual((await call({method:'policy.get'})).policy,view);
  assert.deepEqual(await queryCli(['--service',service.credentialsPath]),view);
  const local=await queryCli(['--workspace',process.cwd(),'--state-dir',path.join(root,'local-state'),'--tool-policy',policyFile]);
  assert.equal(local.digest,view.digest); assert.deepEqual(local.restrictions,view.restrictions); assert.deepEqual(local.execution,view.execution);
  assert.equal(modelCalls,0);
  let identity;
  if(phase==='prepare') {
    assert.deepEqual((await call({method:'session.list'})).sessions,[]);
    const {session}=await call({method:'session.create',idempotencyKey:'create'});
    const {run}=await call({method:'run.start',sessionId:session.sessionId,expectedRevision:session.revision,prompt:'Read private.txt',idempotencyKey:'start'});
    assert.equal(run.status,'completed');
    assert.equal(run.cliResult.policyEvidence.events[0].decision,'deny');
    identity={sessionId:session.sessionId,runId:run.runId};
    await writeFile('identity.sha256',digest(identity));
    await writeFile('policy-snapshot.json',JSON.stringify(view));
  } else {
    const {sessions}=await call({method:'session.list'});
    assert.equal(sessions.length,1);
    const {session}=await call({method:'session.get',sessionId:sessions[0].sessionId});
    assert.equal(session.runs.length,1);
    identity={sessionId:session.sessionId,runId:session.runs[0].runId};
    assert.equal(digest(identity),await readFile('identity.sha256','utf8'));
    assert.deepEqual(view,JSON.parse(await readFile('policy-snapshot.json','utf8')));
    const {run}=await call({method:'run.get',...identity});
    assert.equal(run.cliResult.policyEvidence.events[0].decision,'deny');
  }
  const count=modelCalls;
  const page=await requestHarnessLocalService(credentials,'events',{projectId:hello.projectId,sessionId:identity.sessionId,after:0});
  const decisions=page.events.filter(e=>e.activity.type==='policy-decision');
  assert.equal(decisions.length,1);
  assert.equal(decisions[0].activity.policyDigest,view.digest);
  assert.equal(decisions[0].activity.executionBackend,'none');
  assert.equal(decisions[0].activity.evidence,'policy-evaluation');
  assert(!JSON.stringify(decisions).includes('sk-fixturesecret123'));
  assert(!JSON.stringify(decisions).includes('/private/customer'));
  assert.deepEqual(await requestHarnessLocalService(credentials,'events',{projectId:hello.projectId,sessionId:identity.sessionId,after:0}),page);
  assert.equal(modelCalls,count); assert.equal(harness.workspace.mutationAudit().length,0);
  if(phase==='prepare') await writeFile('decisions.sha256',digest(decisions));
  else assert.equal(digest(decisions),await readFile('decisions.sha256','utf8'));
} finally { await service.close(); }
console.log(JSON.stringify({phase,ok:true,runtime:process.version,queryParity:true,durableReplay:true,noQueryOrReplayExecution:true}));
