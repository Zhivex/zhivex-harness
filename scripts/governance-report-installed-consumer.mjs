import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHarness,runHarness,openHarnessPersistence,resolveHarnessConfig,openCliSessionStore,openHarnessActivityStore,
 exportHarnessGovernanceReport,harnessGovernanceReportSchema,renderHarnessGovernanceMarkdown } from '@zhivex-ai/harness/engine';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
const [phase,scenario]=process.argv.slice(2);
const runId='report-'+scenario;
const marker='PRIVATE_REPORT_CANARY@example.com';
const config=resolveHarnessConfig({workspace:process.cwd()});
const now=Date.parse('2026-09-29T12:00:00.000Z');
if(phase==='execute') {
 const harness=await createHarness({workspace:process.cwd(),subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:marker},{type:'finish',finishReason:'stop'}]]})});
 try {
  await runHarness(harness,{runId,prompt:marker});
  const state=await harness.store.load(runId,harness.config.scope);assert(state);
  // Explicit synthetic durable history fixtures; these do not certify tool execution.
  if(scenario==='failed'){state.status='failed';state.error={message:marker};}
  if(scenario==='rejected')state.metadata={...state.metadata,clientApprovalDecisionsV1:[{approvalId:marker,name:'write_file',digest:'a'.repeat(64),approved:false,decidedAt:1,reviewedRevision:1}]};
  if(scenario==='partial') {
   const child={...structuredClone(state),runId:runId+'-child',parentRunId:runId,status:'cancelled',childRuns:[]};delete child.revision;
   await harness.store.save(child);
   state.childRuns=[{runId:child.runId,agentId:'reviewer',status:'cancelled',toolName:'delegate_reviewer',outputText:marker,steps:0,toolCalls:0,toolErrors:0}];
   state.metadata={...state.metadata,zhivexDelegationAcceptanceV1:{schemaVersion:1,evaluations:[{taskId:'review',childRunId:child.runId,childStatus:'cancelled',accepted:false,reason:'incomplete',semanticReview:'pending',correctionsUsed:0}]}};
  }
  if(scenario==='legacy'){state.metadata={};delete state.usage;}
  await harness.store.save(state,{expectedRevision:state.revision});
 } finally {await harness.close();}
 const sessions=await openCliSessionStore({workspace:config.workspace,stateDirectory:config.stateDirectory,scope:config.scope});
 try {
  const session=await sessions.create({title:marker});
  await sessions.appendRun(session.sessionId,{runId,provider:'fixture',model:'fixture',status:scenario==='failed'?'failed':'completed'});
  await writeFile('../session-'+scenario+'.json',JSON.stringify({sessionId:session.sessionId}));
  const history=await openHarnessActivityStore(config,{now:()=>now,retentionMs:1000});
  try {history.prompt(session.sessionId,runId,marker);history.policyDecision(session.sessionId,runId,{schemaVersion:1,type:'policy-decision',phase:'tool-entry',toolName:'read_file',decision:'allow',ruleIds:[],reason:marker,reasonTruncated:false,policyDigest:null,source:'baseline',approvalRequired:false,explicitReviewRequired:false,executionBackend:'none',evidence:'policy-evaluation'});}finally{history.close();}
 } finally {sessions.close();}
}
const {sessionId}=JSON.parse(await readFile('../session-'+scenario+'.json','utf8'));
const persistence=await openHarnessPersistence(config);
const index=await openCliSessionStore({workspace:config.workspace,stateDirectory:config.stateDirectory,scope:config.scope});
const history=await openHarnessActivityStore(config,{now:()=>now+(scenario==='expired'?2000:0),retentionMs:1000});
try {
 const report=await exportHarnessGovernanceReport(persistence.store,config.scope,runId,{session:{id:sessionId,index,history},now});
 assert.deepEqual(harnessGovernanceReportSchema.parse(JSON.parse(JSON.stringify(report))),report);
 assert(!JSON.stringify(report).includes(marker));assert(!renderHarnessGovernanceMarkdown(report).includes(marker));
 if(scenario==='failed')assert.equal(report.runs[0].failure,'run_failed');
 if(scenario==='rejected')assert.equal(report.runs[0].approvals.items[0].status,'rejected');
 if(scenario==='partial'){assert.equal(report.runs.length,2);assert.equal(report.runs[0].delegations.items[0].recordedAcceptance,false);assert.equal(report.runs[0].delegations.items[0].semanticReview,'pending');}
 if(scenario==='legacy')assert.equal(report.runs[0].usage.inputTokens,null);
 assert.equal(report.eventHistory.retention,scenario==='expired'?'expired':'retained');
 assert.equal(report.eventHistory.incomplete,scenario==='expired');
 const file='../report-'+scenario+'.json';
 if(phase==='execute')await writeFile(file,JSON.stringify(report,null,2));
 else {
  assert.deepEqual(report,JSON.parse(await readFile(file,'utf8')));
  const engine=fileURLToPath(import.meta.resolve('@zhivex-ai/harness/engine'));
  const cli=path.resolve(path.dirname(engine),'../zhx.js');
  for(const json of [false,true]) {
   const child=spawnSync(process.execPath,[cli,'runs','report',runId,'--workspace',process.cwd(),'--session',sessionId,...(json?['--json']:[])],{encoding:'utf8',timeout:20000});
   assert.equal(child.status,0,child.stderr);assert(!child.stdout.includes(marker));
   if(json)assert.deepEqual(harnessGovernanceReportSchema.parse(JSON.parse(child.stdout)).runs,report.runs);
   else assert(child.stdout.includes('# Execution and governance report'));
  }
 }
 console.log(JSON.stringify({phase,scenario,runs:report.runs.length,retention:report.eventHistory.retention,reopened:phase==='inspect',consumerValidated:true,liveProvider:false}));
} finally {history.close();index.close();persistence.close();}
