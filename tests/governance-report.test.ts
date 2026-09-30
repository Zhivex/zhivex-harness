import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { AgentRunState, AgentRunStore, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import { exportHarnessGovernanceReport, harnessGovernanceReportSchema, renderHarnessGovernanceMarkdown } from '../src/persistence/governance-report.js';
import { APPROVAL_HISTORY_KEY, approvalInputDigest } from '../src/approvals/approval-history.js';
import { nextTaskAcceptanceLedger, TASK_ACCEPTANCE_KEY, TASK_ACCEPTANCE_EVIDENCE_KEY } from '../src/runtime/task-acceptance-record.js';
const sha='sha256:'+'a'.repeat(64);
const state=(overrides:Partial<AgentRunState>={})=>({runId:'private-run',revision:1,status:'completed',messages:[],pendingApprovals:[],childRuns:[],metadata:{},...overrides} as AgentRunState);
const store=(states:AgentRunState[],journal:AgentToolCallJournalEntry[]=[]):AgentRunStore=>({
 load:async id=>structuredClone(states.find(state=>state.runId===id)),save:async()=>{throw new Error('EXPORT_MUST_NOT_WRITE');},
 listToolCalls:async id=>structuredClone(journal.filter(row=>row.runId===id))
});
const report=(root=state(),journal:AgentToolCallJournalEntry[]=[])=>exportHarnessGovernanceReport(store([root],journal),undefined,root.runId);

test('legacy completed execution leaves delivery, identity, artifact and usage explicitly unknown',async()=>{
 const root=state({outputText:'private text',usage:{inputTokens:90,outputTokens:20}});
 const value=await report(root);
 expect(value.runs[0]).toMatchObject({status:'completed',finalized:true,identity:'not-verified',delivery:{availability:'unavailable',status:'unknown'},usage:{availability:'unavailable',inputTokens:null,outputTokens:null,estimatedUsd:null}});
 expect(value.executionArtifact).toMatchObject({version:null,digest:null,availability:'unavailable'});
 expect(harnessGovernanceReportSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
 expect(JSON.stringify(value)).not.toContain('private');
 expect(renderHarnessGovernanceMarkdown(value)).toContain('not signatures');
});

test('approved checks bind journal receipts while exporting no free text, arguments, identifiers or outputs',async()=>{
 const secret='TOP_SECRET_CUSTOM_MARKER@example.com';
 const input={command:'node',args:[secret]};
 const root=state({runId:secret,metadata:{[APPROVAL_HISTORY_KEY]:[{approvalId:secret,name:'run_check',digest:'b'.repeat(64),toolCallId:secret,
 inputDigest:approvalInputDigest(input),approved:true,decidedAt:1,reviewedRevision:1,provenance:{schemaVersion:1,origin:'interactive',channel:'console',policyDigest:sha}}]},
 outputText:secret,error:{message:secret}});
 const journal:AgentToolCallJournalEntry[]=[{runId:secret,toolCallId:'journal',providerToolCallId:secret,toolName:'run_check',status:'completed',revision:1,updatedAt:2,idempotencyKey:secret,input,output:{exitCode:0,timedOut:false,stdout:secret,stderr:secret}}];
 const value=await report(root,journal);
 expect(value.runs[0]!.approvals.items[0]).toMatchObject({origin:'interactive',policyDigest:sha,status:'succeeded',exitCode:0});
 expect(JSON.stringify(value)).not.toContain(secret);
 expect(JSON.stringify(value)).not.toContain('command');
 expect(JSON.stringify(value)).not.toContain('stdout');
 const rejected=structuredClone(root);
 (rejected.metadata![APPROVAL_HISTORY_KEY] as Array<{approved:boolean}>)[0]!.approved=false;
 expect((await report(rejected,journal)).runs[0]!.approvals.items[0]!.status).toBe('rejected');
});

test('partial children remain distinct from completed parent; foreign scope and missing children are not exported',async()=>{
 const root=state({childRuns:[{runId:'child'},{runId:'missing'},{runId:'foreign'}] as NonNullable<AgentRunState['childRuns']>});
 const child=state({runId:'child',parentRunId:root.runId,status:'cancelled'});
 const foreign=state({runId:'foreign',parentRunId:root.runId,scope:{tenantId:'other',namespace:'private'}});
 const value=await exportHarnessGovernanceReport(store([root,child,foreign]),undefined,root.runId);
 expect(value.runs).toHaveLength(2);expect(value.missingChildren).toHaveLength(2);
 expect(value.runs[1]).toMatchObject({status:'cancelled',failure:'cancelled',finalized:true});
 expect(value.limitations).toContain('missing_child');
});

test('contract mismatch is invalid, not a verified delivery, and malformed histories do not leak errors',async()=>{
 const ledger=nextTaskAcceptanceLedger(undefined,{schemaVersion:1,taskId:'repair',allowedWritePaths:[],protectedFiles:[],requiredChecks:[{id:'tests',kind:'argv',command:'node',args:['--test'],purpose:'private-purpose',execution:{backend:'oci',approval:'required',network:'none'}}],humanReview:[]});
 const root=state({metadata:JSON.parse(JSON.stringify({[TASK_ACCEPTANCE_KEY]:ledger,[TASK_ACCEPTANCE_EVIDENCE_KEY]:{schemaVersion:1,contractRevision:1,contractDigest:sha,status:'verified',checks:[]}}))});
 const value=await report(root);
 expect(value.runs[0]!.contract).toMatchObject({availability:'recorded',requiredChecks:1});
 expect(value.runs[0]!.delivery).toMatchObject({availability:'invalid',status:'unknown'});
 expect(JSON.stringify(value)).not.toContain('private-purpose');
 root.metadata![TASK_ACCEPTANCE_KEY]={invalid:'SECRET'};
 root.metadata![APPROVAL_HISTORY_KEY]=[{invalid:'SECRET'}];
 const invalid=await report(root);
 expect(invalid.limitations).toContain('invalid_contract');expect(invalid.limitations).toContain('invalid_approvals');
 expect(JSON.stringify(invalid)).not.toContain('SECRET');
});

test('no ledger means no fabricated zero; incomplete ledger keeps available amounts explicitly partial',async()=>{
 const value=await report(state({metadata:{zhivexUsageLedger:{schemaVersion:1,runId:'private-run',calls:2,inputTokens:4,outputTokens:0,usageComplete:false,historicalUsageUnknown:true,estimatedUsd:null,limitUsd:null,costKind:'estimate-not-invoice',routes:[]}}}));
 expect(value.runs[0]!.usage).toMatchObject({availability:'recorded',inputTokens:4,outputTokens:0,complete:false,estimatedUsd:null});
});

test('concurrent changes, including mutable store objects, fail instead of mixing revisions',async()=>{
 const root=state();let loads=0;
 const unsafe:AgentRunStore={...store([root]),load:async()=>{if(++loads>1)root.revision=2;return root;}};
 await expect(exportHarnessGovernanceReport(unsafe,undefined,root.runId)).rejects.toThrow('GOVERNANCE_STATE_CHANGED');
});

test('strict consumer rejects unknown fields and large journals are refused',async()=>{
 const value=await report();expect(harnessGovernanceReportSchema.safeParse({...value,prompt:'injection'}).success).toBe(false);
 const root=state();const oversized={...store([root]),listToolCalls:async()=>Array.from({length:2049},()=>({runId:root.runId} as AgentToolCallJournalEntry))};
 await expect(exportHarnessGovernanceReport(oversized,undefined,root.runId)).rejects.toThrow('GOVERNANCE_JOURNAL_LIMIT');
});

test('recorded verified outcome requires matching contract, checks and import binding',async()=>{
 const ledger=nextTaskAcceptanceLedger(undefined,{schemaVersion:1,taskId:'repair',allowedWritePaths:[],protectedFiles:[],requiredChecks:[{id:'tests',kind:'argv',command:'node',args:['--test'],purpose:'Tests',execution:{backend:'oci',approval:'required',network:'none'}}],humanReview:[]});
 const revision=ledger.revisions[0]!;
 const delivery={runId:'private-run',executionIdentity:'private-container',patchId:sha,snapshotDigest:sha};
 const check={schemaVersion:1,checkId:'tests',contractRevision:1,contractDigest:revision.digest,...delivery,argvDigest:'sha256:'+createHash('sha256').update(JSON.stringify(['node','--test'])).digest('hex'),exitCode:0,timedOut:false,unchanged:true};
 const evidence={schemaVersion:1,contractRevision:1,contractDigest:revision.digest,status:'verified',checks:[check],delivery};
 const root=state({metadata:JSON.parse(JSON.stringify({[TASK_ACCEPTANCE_KEY]:ledger,[TASK_ACCEPTANCE_EVIDENCE_KEY]:evidence}))});
 expect((await report(root)).runs[0]!.delivery).toMatchObject({status:'verified',patchId:sha,interpretation:'recorded-checkpoint-not-current-workspace-verification'});
 for(const invalid of [{...evidence,checks:[]},{...evidence,checks:[{...check,timedOut:true}]},{...evidence,delivery:{...delivery,runId:'other'}},{...evidence,checks:[{...check,snapshotDigest:'sha256:'+'b'.repeat(64)}]}]) {
  root.metadata![TASK_ACCEPTANCE_EVIDENCE_KEY]=JSON.parse(JSON.stringify(invalid));
  expect((await report(root)).runs[0]!.delivery.status).toBe('unknown');
 }
});

test('SQLite projection is stable after closing and reopening; no additional model calls',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {createMockLanguageModel}=await import('@zhivex-ai/agents/testing');
 const {createHarness,runHarness}=await import('../src/runtime/harness.js');
 const root=await mkdtemp('/tmp/har-governance-');
 const model=createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'PRIVATE OUTPUT'},{type:'finish',finishReason:'stop'}]]});
 const open=()=>createHarness({workspace:root,subagentProfiles:[],modelInstance:model});
 let harness=await open();
 try {
  const execution=await runHarness(harness,{prompt:'PRIVATE PROMPT'});
  const before=await exportHarnessGovernanceReport(harness.store,harness.config.scope,execution.state.runId);
  await harness.close();harness=await open();
  const after=await exportHarnessGovernanceReport(harness.store,harness.config.scope,execution.state.runId);
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain('PRIVATE');
 } finally {await harness.close();await rm(root,{recursive:true,force:true});}
});

test('known provider failure causes survive without free-form diagnostics or messages',async()=>{
 const value=await report(state({status:'failed',error:{message:'PRIVATE FAILURE',diagnosticCode:'PRIVATE CODE',category:'provider-tool-call',reason:'invalid_json'}}));
 expect(value.runs[0]!.failureDetails).toMatchObject({providerToolReason:'invalid_json'});
 expect(JSON.stringify(value)).not.toContain('PRIVATE');
});
