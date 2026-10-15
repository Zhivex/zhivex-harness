// Independent installed consumer: public exports only, synthetic local transport, no UI/provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHarness, runHarness, openCliSessionStore } from '@zhivex-ai/harness/engine';
import { initializeHarnessTaskBudget, inspectHarnessTaskBudget, runHarnessTask } from '@zhivex-ai/harness/code-support';
import { startHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService, openHarnessActivityStore } from '@zhivex-ai/harness/service';
import { harnessTaskProjectionSchema, reduceHarnessTaskProjection } from '@zhivex-ai/harness/protocol';

const parent = process.env.HARNESS_RECOVERY_LAB_ROOT ?? await mkdtemp('/tmp/hu73-owned-');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(parent + '/p-');
const fixtures = {
  'greeting.mjs': 'export const greeting = name => `Hello, ${name}!`;\n',
  'effects.log': '',
  'check.mjs': "import assert from 'node:assert/strict'; import {appendFileSync,existsSync} from 'node:fs'; import {greeting} from './greeting.mjs'; if(existsSync('inject-effect')) appendFileSync('effects.log','effect\\n'); assert.equal(greeting('Ada'),'Hello, Ada!');\n",
  'package.json': JSON.stringify({ private: true, type: 'module', packageManager: 'npm@11.0.0', scripts: { test: 'node check.mjs' } }) + '\n'
};
const hash = value => createHash('sha256').update(value).digest('hex');
const fixtureSha256 = hash(JSON.stringify(fixtures));
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const done = [{ type: 'text-delta', textDelta: 'Untrusted provider claim' }, { type: 'finish', finishReason: 'stop', usage }];
const check = [{ type: 'tool-call', toolCall: { id: 'check', name: 'run_check', input: { check: 'test', expectedScript: 'node check.mjs' } } }, { type: 'finish', finishReason: 'tool-calls', usage }];
let modelRequests = 0;
const model = { provider: 'mock', modelId: 'projection-offline', get requests() { return modelRequests; },
  capabilities: { streaming: true, tools: true, structuredOutput: true, jsonMode: true, toolChoice: true, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
  async generate() { throw new Error('UNEXPECTED_GENERATE'); },
  async stream() { const events = modelRequests++ === 0 ? check : done; return (async function* () { yield* events; })(); }
};
const contract = { schemaVersion: 1, taskId: 'projection', allowedWritePaths: ['greeting.mjs', 'effects.log'], protectedFiles: ['package.json', 'check.mjs'],
  requiredChecks: [{ id: 'test', kind: 'package-script', script: 'test', expectedScript: 'node check.mjs', command: 'npm', args: ['--ignore-scripts','run','test'], purpose: 'Frozen greeting oracle', execution: { backend: 'none', approval: 'required' } }],
  humanReview: [{ id: 'human', requirement: 'Review exact greeting', status: 'pending' }] };
const scenarios = []; let current = 'setup', host, sessions, service, credentials, hello, sessionId, requestId = 0;
async function scenario(id, work) { current = id; const evidence = await work(); scenarios.push({ id, result: 'passed', humanAccepted: false, automaticEffectReplay: false, ...evidence }); }
const open = () => createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: model });
const connect = async () => { credentials = await readHarnessLocalCredentials(service.credentialsPath); hello = await requestHarnessLocalService(credentials, 'hello', { versions: [1] }); assert.equal(hello.ok,true); };
const read = (extra = {}) => requestHarnessLocalService(credentials, 'command', { protocolVersion: 1, requestId: `r${++requestId}`, connectionId: hello.connectionId,
  command: { method: 'task.get', projectId: hello.projectId, sessionId, runId: 'first', projectionVersion: 1, ...extra } });
const snapshot = async () => { const response = await read(); assert.equal(response.ok,true,JSON.stringify(response)); assert.equal(response.data.kind,'task'); return harnessTaskProjectionSchema.parse(response.data.projection); };
const expected = p => ({ connectionId: p.connectionId, projectId: p.projectId, sessionId: p.sessionId, runId: p.runId });
try {
  for (const [name, bytes] of Object.entries(fixtures)) await writeFile(root + '/' + name, bytes);
  host = await open(); await initializeHarnessTaskBudget(host,contract.taskId,{inputTokens:60000,outputTokens:8192,totalTokens:68192});
  await runHarnessTask(host,{runId:'first',prompt:'Operator objective PRIVATE_FIXTURE sk-fixturetoken '+root},{taskAcceptance:contract,taskBudgetExisting:true,
    resolveApprovals:async items=>items.map(item=>({provider:item.provider,approvalRequestId:item.id,approve:true}))});
  sessions = await openCliSessionStore({ workspace:root,stateDirectory:host.config.stateDirectory,scope:host.config.scope });
  const session=await sessions.create();sessionId=session.sessionId;
  await sessions.appendRun(sessionId,{runId:'first',provider:'mock',model:'projection-offline',status:'completed'},{expectedRevision:session.revision});
  service=await startHarnessLocalService(host,{directory:root+'/socket',sensitiveValues:['PRIVATE_FIXTURE'],maxEvents:1});await connect();
  await scenario('negotiation-version',async()=>{
    assert.ok(hello.capabilities.includes('task.projection.v1'));
    const denied=await read({projectionVersion:99});assert.equal(denied.error.code,'VERSION_UNSUPPORTED');assert.equal(denied.error.taskDiagnostic.cause,'UNSUPPORTED_VERSION');
    return {unsupportedRefused:true};
  });
  let initial;
  await scenario('snapshot-read-only',async()=>{
    const before=JSON.stringify([await sessions.get(sessionId),await host.store.load('first',host.config.scope),await inspectHarnessTaskBudget(host,contract.taskId)]), calls=model.requests;
    initial=await snapshot();assert.equal(initial.task.review.structure,'verified');assert.equal(initial.task.review.semantic,'pending');assert.equal(initial.task.review.acceptance,'not_recorded');
    assert.equal(initial.task.review.human[0].status,'pending');assert.equal(initial.task.budget.confirmed.totalTokens,30);
    assert.equal(initial.task.artifact.correspondence,'current');assert.equal(initial.task.nextAction.permitted,'read_only');
    assert.equal(JSON.stringify([await sessions.get(sessionId),await host.store.load('first',host.config.scope),await inspectHarnessTaskBudget(host,contract.taskId)]),before);assert.equal(model.requests,calls);
    assert.equal(await readFile(root+'/effects.log','utf8'),'');return {structure:'verified',semantic:'pending',acceptance:'not_recorded',providerCallsDuringRead:0};
  });
  await scenario('host-redaction',async()=>{
    const serialized=JSON.stringify(initial);for(const secret of ['PRIVATE_FIXTURE','sk-fixturetoken',root,'Untrusted provider claim'])assert.ok(!serialized.includes(secret));
    assert.ok(Buffer.byteLength(serialized)<=64*1024);return {redacted:true,bounded:true};
  });
  await scenario('duplicate-out-of-order',async()=>{
    const next=await snapshot(),scope=expected(next),current=reduceHarnessTaskProjection(null,next,scope).snapshot;
    assert.equal(reduceHarnessTaskProjection(current,initial,scope).status,'ignored');assert.equal(reduceHarnessTaskProjection(current,next,scope).status,'ignored');
    assert.equal(reduceHarnessTaskProjection(current,{...next,schemaVersion:99},scope).status,'refresh_required');
    assert.equal(reduceHarnessTaskProjection(current,next,{...scope,sessionId:'foreign'}).snapshot,null);return {oneProjection:true};
  });
  await scenario('artifact-scope',async()=>{
    for(const extra of [{runId:'foreign'},{sessionId:'foreign'},{projectId:'foreign'}])assert.equal((await read(extra)).error.code,'NOT_FOUND');
    assert.equal((await read({artifactPath:'/outside/private'})).error.code,'INVALID_REQUEST');return {foreignArtifactRefused:true};
  });
  await scenario('cursor-expiry-replay',async()=>{
    const activity=await openHarnessActivityStore(host.config,{maxEvents:1});try{activity.checkpoint(sessionId,'first','completed');activity.checkpoint(sessionId,'first','completed');}finally{activity.close();}
    const page=await requestHarnessLocalService(credentials,'events',{projectId:hello.projectId,sessionId,after:0});assert.equal(page.cursorExpired,true);assert.ok(page.snapshot);
    const before=model.requests;const refreshed=await snapshot();assert.deepEqual(refreshed.task,initial.task);
    // Repeated/old activity pages only request a fresh read; no event invokes an effect.
    const replay=await requestHarnessLocalService(credentials,'events',{projectId:hello.projectId,sessionId,after:page.nextCursor});assert.equal(replay.events.length,0);
    assert.equal(model.requests,before);return {cursorExpired:true,freshSnapshotEquivalent:true,providerCallsDuringReplay:0};
  });
  await scenario('paused-host-read',async()=>{service.pauseAdmission();try{assert.deepEqual((await snapshot()).task,initial.task);}finally{service.resumeAdmission();}return {readAvailable:true};});
  await scenario('restart-new-epoch',async()=>{
    const old=await snapshot(),oldCredentials=credentials; sessions.close();sessions=undefined;await service.close();service=undefined;host=await open();
    service=await startHarnessLocalService(host,{directory:root+'/socket',sensitiveValues:['PRIVATE_FIXTURE'],maxEvents:1});await connect();
    await assert.rejects(requestHarnessLocalService(oldCredentials,'hello',{versions:[1]}));const next=await snapshot();assert.notEqual(next.connectionId,old.connectionId);assert.deepEqual(next.task,old.task);
    assert.equal(reduceHarnessTaskProjection(next,old,expected(next)).status,'refresh_required');assert.deepEqual(reduceHarnessTaskProjection(next,old,expected(next)).snapshot,next);
    return {oldEpochRejected:true,durableTaskEquivalent:true};
  });
  await scenario('artifact-drift',async()=>{await writeFile(root+'/greeting.mjs','export const greeting = () => "changed";\n');const p=await snapshot();assert.equal(p.task.review.structure,'incomplete');assert.equal(p.task.artifact.correspondence,'stale');assert.equal(p.task.review.checks[0].status,'missing_or_stale');return {stale:true,noChecksRerun:true};});
  await scenario('legacy-budget',async()=>{
    await runHarness(host,{runId:'legacy',prompt:'Legacy objective'},{taskAcceptance:{...contract,taskId:'legacy'}});
    const index=await openCliSessionStore({workspace:root,stateDirectory:host.config.stateDirectory,scope:host.config.scope});try{const s=await index.get(sessionId);await index.appendRun(sessionId,{runId:'legacy',provider:'mock',model:'projection-offline',status:'completed'},{expectedRevision:s.revision});}finally{index.close();}
    const r=await read({runId:'legacy'});assert.equal(r.ok,true);assert.equal(r.data.projection.task.budget.availability,'legacy_not_enabled');assert.equal(r.data.projection.task.budget.confirmed,null);return {budgetNotInvented:true};
  });
  console.log(JSON.stringify({status:'passed',phase:'HAR73 installed public projection',fullStoryAccepted:false,liveProvider:false,fixtureSha256,scenarios}));
} catch { console.error(JSON.stringify({status:'failed',scenario:current,diagnostic:'PROJECTION_CONSUMER_ASSERTION',completed:scenarios.map(row=>row.id)}));process.exitCode=1; }
finally { sessions?.close();if(service)await service.close();else await host?.close();await rm(root,{recursive:true,force:true});if(!process.env.HARNESS_RECOVERY_LAB_ROOT)await rm(parent,{recursive:true,force:true}); }
