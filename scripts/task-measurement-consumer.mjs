// Isolated installed consumer. Public exports only; no source-tree dependency.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createHarness,openCliSessionStore,exportHarnessGovernanceReport} from '@zhivex-ai/harness/engine';
import {initializeHarnessTaskBudget,inspectHarnessTaskBudget,runHarnessTask} from '@zhivex-ai/harness/code-support';
import {startHarnessLocalService,readHarnessLocalCredentials,requestHarnessLocalService} from '@zhivex-ai/harness/service';
import {harnessTaskProjectionSchema} from '@zhivex-ai/harness/protocol';
const [mode,root,specFile,output] = process.argv.slice(2);
const spec=JSON.parse(await readFile(specFile,'utf8'));
const hash=v=>createHash('sha256').update(v).digest('hex');
let calls=0,host,service,sessions;
const usage={inputTokens:10,outputTokens:5,totalTokens:15};
const tool=(id,name,input)=>[{type:'tool-call',toolCall:{id,name,input}},{type:'finish',finishReason:'tool-calls',usage}];
const events=[tool('edit','apply_reviewed_edits',{changes:[{path:'solution.mjs',expectedDigest:`sha256:${hash(spec.initial)}`,content:spec.solution}]}),
 tool('check','run_check',{check:'test',expectedScript:'node check.mjs'}),[{type:'text-delta',textDelta:'Synthetic provider claim is not acceptance'},{type:'finish',finishReason:'stop',usage}]];
const model={provider:'mock',modelId:'hu74-offline',capabilities:{streaming:true,tools:true,structuredOutput:true,jsonMode:true,toolChoice:true,parallelToolCalls:false,vision:false,files:false,audioInput:false,audioOutput:false,embeddings:false,reasoning:false,webSearch:false},
 async generate(){throw Error('UNEXPECTED_GENERATE');},async stream(){assert.equal(mode,'run','READ_DISPATCHED_MODEL');const e=events[calls++];assert(e,'EXCESS_MODEL_CALL');return(async function*(){yield* e;})();}};
try{
 const start=performance.now();
 host=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],maxSteps:16,maxToolCalls:40,timeoutMs:150000,modelInstance:model});
 if(mode==='audit'){
  let budget=null,run=null;try{budget=await inspectHarnessTaskBudget(host,'measurement');}catch{}
  try{const state=await host.store.load('first',host.config.scope);run=state?{status:state.status,revision:state.revision}:null;}catch{}
  await writeFile(output+'/failure-account.json',JSON.stringify({budget,run,auditModelCalls:calls,attemptModelCalls:null,missingBudget:budget===null},null,2));
  await host.close();host=undefined;process.exit(0);
 }
 let generation;
 if(mode==='run'){
  const contract={schemaVersion:1,taskId:'measurement',allowedWritePaths:['solution.mjs'],protectedFiles:['package.json','check.mjs'],requiredChecks:[{id:'test',kind:'package-script',script:'test',expectedScript:'node check.mjs',command:'npm',args:['--ignore-scripts','run','test'],purpose:spec.objective,execution:{backend:'none',approval:'required'}}],humanReview:[{id:'human',requirement:spec.objective,status:'pending'}]};
  await initializeHarnessTaskBudget(host,'measurement',{inputTokens:60000,outputTokens:8192,totalTokens:68192});
  const t=performance.now();
  const result=await runHarnessTask(host,{runId:'first',prompt:spec.objective},{taskAcceptance:contract,taskBudgetExisting:true,resolveApprovals:async items=>items.map(item=>({provider:item.provider,approvalRequestId:item.id,approve:true}))});
  generation={executionMs:performance.now()-t,modelCalls:calls,status:result.status};
  assert.equal(result.status,'completed');assert.equal(calls,3);
  sessions=await openCliSessionStore({workspace:root,stateDirectory:host.config.stateDirectory,scope:host.config.scope});
  const session=await sessions.create();await sessions.appendRun(session.sessionId,{runId:'first',provider:'mock',model:'hu74-offline',status:'completed'},{expectedRevision:session.revision});
  await writeFile(output+'/session-id',session.sessionId);
  await writeFile(output+'/generation.json',JSON.stringify(generation,null,2));
  if(spec.journey==='handoff'){
   // IPC barrier after durable completion; parent must kill and await process exit.
   process.send({ready:true});await new Promise(()=>{});
  }
 }
 const sessionId=await readFile(output+'/session-id','utf8');
 const baselineStart=performance.now();
 const governance=await exportHarnessGovernanceReport(host.store,host.config.scope,'first');
 const budget=await inspectHarnessTaskBudget(host,'measurement');
 const artifact=await readFile(root+'/solution.mjs','utf8');
 const artifactSha256=hash(artifact);
 const protectedIntact=(await readFile(root+'/check.mjs','utf8'))===spec.check && (await readFile(root+'/package.json','utf8'))===spec.package;
 const diff=execFileSync('git',['diff','--','solution.mjs'],{cwd:root,encoding:'utf8'});
 assert.equal(governance.runs.length,1);assert.equal(governance.runs[0].journal.entries,2);assert.equal(governance.runs[0].journal.failed,0);assert.equal(governance.runs[0].journal.unfinished,0);
 const baselineMs=performance.now()-baselineStart;
 service=await startHarnessLocalService(host,{directory:root+'/socket'});
 const credentials=await readHarnessLocalCredentials(service.credentialsPath),hello=await requestHarnessLocalService(credentials,'hello',{versions:[1]});assert.equal(hello.ok,true);
 const before=JSON.stringify(await inspectHarnessTaskBudget(host,'measurement'));
 const pStart=performance.now();
 const response=await requestHarnessLocalService(credentials,'command',{protocolVersion:1,requestId:'measurement-read',connectionId:hello.connectionId,command:{method:'task.get',projectId:hello.projectId,sessionId,runId:'first',projectionVersion:1}});
 assert.equal(response.ok,true);const projection=harnessTaskProjectionSchema.parse(response.data.projection);const projectionMs=performance.now()-pStart;
 assert.equal(JSON.stringify(await inspectHarnessTaskBudget(host,'measurement')),before);
 assert.equal(projection.task.review.semantic,'pending');assert.equal(projection.task.review.acceptance,'not_recorded');assert.equal(mode==='read'?calls:0,0);
 const identity={artifactSha256,runId:'first',taskReference:projection.task.reference,contractDigest:projection.task.contractDigest,runRevision:projection.task.runRevision};
 await writeFile(output+'/baseline.json',JSON.stringify({identity,objective:spec.objective,artifact,diff,governance,budget},null,2));
 await writeFile(output+'/treatment.json',JSON.stringify({identity,objective:spec.objective,artifact,projection},null,2));
 const result={status:'completed',identity,artifact,protectedIntact,projection,budget,generation: generation??JSON.parse(await readFile(output+'/generation.json','utf8')),
  latency:{baselineMaterializationMs:baselineMs,projectionReadMs:projectionMs,reopenAndReadMs:mode==='read'?performance.now()-start:null},readModelCalls:mode==='read'?calls:0,
  journalEntries:governance.runs[0].journal.entries,humanAccepted:null,humanMinutes:null};
 await writeFile(output+'/consumer.json',JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({diagnostic:'CONSUMER_FAILED',message:error.message}));process.exitCode=1;}
finally{sessions?.close();if(service)await service.close();else await host?.close();}
