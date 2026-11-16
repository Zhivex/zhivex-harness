import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentRunState, AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import { approvalDecisionViews, APPROVAL_HISTORY_KEY } from '../approvals/approval-history.js';
import { inspectUsageLedger, USAGE_LEDGER_KEY } from '../runtime/usage-ledger.js';
import { readTaskAcceptanceLedger, TASK_ACCEPTANCE_EVIDENCE_KEY } from '../runtime/task-acceptance-record.js';
import { taskCheckReceiptSchema } from '../runtime/task-acceptance-checks.js';
import { inspectRuntimeManifest } from '../runtime/runtime-diagnostics.js';
import { governanceReference as reference, governanceSessionSchema, governanceHistorySchema, governanceEnvelopeSchema, readGovernanceSession, projectGovernanceEnvelopes, type GovernanceSessionSource } from './governance-context.js';
import { HARNESS_VERSION } from '../version.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const version=z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const bindingSchema=z.object({schemaVersion:z.literal(1),id:z.literal('zhivex-harness'),version,fingerprint:digest,algorithm:z.literal('sha256')});
const count = z.number().int().nonnegative().safe();
const status = z.enum(['created','running','waiting_approval','cancel_requested','completed','failed','cancelled','timed_out','unknown']);
const availability = z.enum(['recorded','unavailable','invalid']);
const providerReason=z.enum(['empty_arguments','invalid_json','arguments_too_large','incomplete_arguments','inconsistent_metadata','response_failed','response_incomplete','stream_truncated']);
const deliveryReason=z.enum(['TASK_ACCEPTANCE_NO_DELIVERY_EVIDENCE','TASK_ACCEPTANCE_SCOPE_VIOLATION','TASK_ACCEPTANCE_RUN_NOT_COMPLETED','TASK_ACCEPTANCE_RUN_NOT_FINISHED','TASK_ACCEPTANCE_IMPORT_UNCONFIRMED','TASK_ACCEPTANCE_CHECKS_MISSING','TASK_ACCEPTANCE_DELIVERY_DRIFT','TASK_ACCEPTANCE_DELIVERY_INSPECTION_FAILED','TASK_ACCEPTANCE_HUMAN_REVIEW_REQUIRED','TASK_ACCEPTANCE_VERIFIED']);
const deliveryStatus = z.enum(['pending','incomplete','failed','pending_review','verified','unknown']);
const checkSchema = z.strictObject({ reference:digest, argvDigest:digest, patchId:digest, snapshotDigest:digest,
  exitCode:z.number().int(), timedOut:z.boolean(), unchanged:z.boolean() });
const deliverySchema = z.object({ schemaVersion:z.literal(1), contractRevision:count, contractDigest:digest,
  status:deliveryStatus, checks:z.array(taskCheckReceiptSchema).max(32),
  delivery:z.object({runId:z.string().max(512),executionIdentity:z.string().max(512),patchId:digest,snapshotDigest:digest}).optional() });
const approvalSchema = z.strictObject({ reference:digest, toolReference:digest, approved:z.boolean(),
  origin:z.enum(['interactive','automatic','application','unknown']), channelReference:digest,
  policyDigest:digest.nullable(), status:z.enum(['rejected','approved','applied','succeeded','failed','unknown']),
  proposalId:digest.nullable(), exitCode:z.number().int().nullable(), timedOut:z.boolean().nullable(),
  effects:z.array(z.strictObject({pathReference:digest,beforeDigest:digest.nullable(),afterDigest:digest.nullable()})).max(50) });
const delegationReason=z.enum(['valid','invalid_json','invalid_schema','task_mismatch','incomplete','duplicate_claim','path_denied','evidence_missing','coverage_missing','missing_child','child_identity_unavailable']);
const delegationSchema=z.strictObject({taskReference:digest,childReference:digest.nullable(),recordedAcceptance:z.boolean(),reason:delegationReason,
  semanticReview:z.enum(['pending','not_requested']),correctionsUsed:count.nullable()});
const delegationInput=z.object({schemaVersion:z.literal(1),evaluations:z.array(z.object({taskId:z.string().max(128),childRunId:z.string().max(512).nullable(),
  childStatus:z.string().max(32),accepted:z.boolean(),reason:delegationReason,semanticReview:z.enum(['pending','not_requested']),correctionsUsed:count.optional()})).max(64)});
const runSchema = z.strictObject({ reference:digest, parentReference:digest.nullable(), revision:count.nullable(),
  status, finalized:z.boolean(), failure:z.enum(['run_failed','cancelled','timed_out','not_reported']).nullable(),
  failureDetails:z.strictObject({providerToolReason:providerReason.nullable(),diagnosticReference:digest.nullable(),deliveryReason:deliveryReason.nullable()}),
  identity:z.literal('not-verified'), runtimePolicy:z.enum(['assistant-v3-durable-closure']).nullable(),
  contract:z.strictObject({availability, digest:digest.nullable(),revision:count.nullable(),requiredChecks:count.nullable(),humanReviewsPending:count.nullable(),allowedWritePathReferences:z.array(digest).max(256),protectedPathReferences:z.array(digest).max(256),
    checks:z.array(z.strictObject({reference:digest,argvDigest:digest,kind:z.enum(['argv','package-script']),backend:z.enum(['none','oci']),approval:z.literal('required')})).max(32),humanReviewReferences:z.array(digest).max(32)}),
  delivery:z.strictObject({availability,status:deliveryStatus,patchId:digest.nullable(),snapshotDigest:digest.nullable(),
    interpretation:z.literal('recorded-checkpoint-not-current-workspace-verification'),checks:z.array(checkSchema).max(32)}),
  approvals:z.strictObject({availability,items:z.array(approvalSchema).max(512)}),
  usage:z.strictObject({availability:z.enum(['recorded','unavailable']),calls:count.nullable(),inputTokens:count.nullable(),outputTokens:count.nullable(),
    complete:z.boolean().nullable(),estimatedUsd:z.number().finite().nonnegative().nullable(),costKind:z.literal('estimate-not-invoice')}),
  journal:z.strictObject({availability:z.enum(['recorded','unavailable']),entries:count,failed:count,unfinished:count}),
  delegations:z.strictObject({availability,interpretation:z.literal('recorded-checkpoint-not-semantic-review'),items:z.array(delegationSchema).max(64)}),
  children:z.array(digest).max(64)
});

/** Experimental v1 projection. No messages, arguments, outputs or arbitrary metadata fields. */
export const harnessGovernanceReportSchema = z.strictObject({
  schemaVersion:z.literal(1), kind:z.literal('harness-governance-report'),
  exporterVersion:z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  executionArtifact:z.strictObject({version:version.nullable(),digest:z.null(),availability:z.enum(['recorded-version','unavailable']),configurationFingerprint:digest.nullable(),authenticity:z.literal('not-verified')}),
  rootReference:digest, identity:z.literal('not-verified'),
  referencePolicy:z.literal('sha256-domain-separated-pseudonyms-not-anonymity'),
  session:governanceSessionSchema,
  eventHistory:governanceHistorySchema,
  changeEnvelopes:z.array(governanceEnvelopeSchema).max(32),
  runs:z.array(runSchema).max(64), missingChildren:z.array(digest).max(64),
  limitations:z.array(z.enum(['tree_limit','missing_child','invalid_contract','invalid_delivery','invalid_approvals','journal_unavailable'])).max(6)
});
export type HarnessGovernanceReport = z.infer<typeof harnessGovernanceReportSchema>;
export interface HarnessGovernanceOptions { session?:GovernanceSessionSource; changeEnvelopes?:readonly unknown[]; now?:number }
const MAX_JOURNAL = 2048;
const MAX_REPORT_BYTES = 2*1024*1024;
const sameScope = (state:AgentRunState,scope:AgentStoreScope|undefined) => !state.scope ||
  state.scope.tenantId===scope?.tenantId && state.scope.userId===scope?.userId && state.scope.namespace===scope?.namespace;

function projectRun(state:AgentRunState,journal:AgentToolCallJournalEntry[]|undefined,limitations:Set<HarnessGovernanceReport['limitations'][number]>):HarnessGovernanceReport['runs'][number] {
  const runStatus=status.safeParse(state.status);
  const stateStatus=runStatus.success?runStatus.data:'unknown';
  let ledger:ReturnType<typeof readTaskAcceptanceLedger>;
  let contractAvailability:z.infer<typeof availability>='unavailable';
  try {ledger=readTaskAcceptanceLedger(state);if(ledger)contractAvailability='recorded';}
  catch {contractAvailability='invalid';limitations.add('invalid_contract');}
  const contract=ledger?.revisions.at(-1);
  const rawDelivery=state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY];
  const parsedDelivery=deliverySchema.safeParse(rawDelivery);
  const bound=parsedDelivery.success && contract && parsedDelivery.data.contractDigest===contract.digest && parsedDelivery.data.contractRevision===contract.revision &&
    (!parsedDelivery.data.delivery || parsedDelivery.data.delivery.runId===state.runId);
  const candidate=bound?parsedDelivery.data:undefined;
  const verified=candidate?.status==='verified' || candidate?.status==='pending_review';
  const validSuccess=!verified || stateStatus==='completed' && candidate.delivery && contract &&
    contract.contract.requiredChecks.every(required=>candidate.checks.some(check=>check.checkId===required.id && check.runId===state.runId &&
      check.argvDigest==='sha256:'+createHash('sha256').update(JSON.stringify([required.command,...required.args])).digest('hex') &&
      check.contractDigest===contract.digest && check.contractRevision===contract.revision && check.exitCode===0 && !check.timedOut && check.unchanged &&
      check.patchId===candidate.delivery!.patchId && check.snapshotDigest===candidate.delivery!.snapshotDigest && check.executionIdentity===candidate.delivery!.executionIdentity)) &&
    (candidate.status==='pending_review')===(contract.contract.humanReview.length>0);
  const delivery=validSuccess?candidate:undefined;
  if(rawDelivery!==undefined && !delivery)limitations.add('invalid_delivery');
  const approvals:HarnessGovernanceReport['runs'][number]['approvals']={availability:state.metadata?.[APPROVAL_HISTORY_KEY]===undefined?'unavailable':'recorded',items:[]};
  try {
    for(let offset=0;offset<512;offset+=25) {
      const rows=approvalDecisionViews(state,journal??[],offset);
      for(const row of rows) approvals.items.push({reference:reference('approval',row.approvalId),toolReference:reference('tool',row.name),approved:row.approved,
        origin:row.provenance?.origin??'unknown',channelReference:reference('channel',row.provenance?.channel??'unknown'),policyDigest:row.provenance?.policyDigest??null,
        status:row.status,proposalId:row.evidence?.proposalId??null,exitCode:row.evidence?.exitCode??null,timedOut:row.evidence?.timedOut??null,
        effects:(row.evidence?.effects??[]).map(effect=>({pathReference:reference('path',effect.path),beforeDigest:effect.beforeDigest,afterDigest:effect.afterDigest}))});
      if(rows.length<25)break;
    }
  } catch {approvals.availability='invalid';approvals.items=[];limitations.add('invalid_approvals');}
  const parsedUsage=inspectUsageLedger(state.metadata?.[USAGE_LEDGER_KEY]);
  const usage=parsedUsage?.runId===state.runId?parsedUsage:null;
  const rawDelegations=state.metadata?.zhivexDelegationAcceptanceV1;
  const delegations=delegationInput.safeParse(rawDelegations);
  const manifest=inspectRuntimeManifest(state.metadata?.effectiveRuntime);
  return {reference:reference('run',state.runId),parentReference:state.parentRunId?reference('run',state.parentRunId):null,
    revision:count.safeParse(state.revision).success?state.revision!:null,status:stateStatus,
    finalized:['completed','failed','cancelled','timed_out'].includes(stateStatus),
    failure:stateStatus==='failed'?'run_failed':stateStatus==='cancelled'?'cancelled':stateStatus==='timed_out'?'timed_out':state.error?'not_reported':null,
    failureDetails:{providerToolReason:providerReason.safeParse(state.error?.reason).success?state.error!.reason!:null,diagnosticReference:state.error?.diagnosticCode?reference('diagnostic',state.error.diagnosticCode):null,
      deliveryReason:deliveryReason.safeParse(rawDelivery && typeof rawDelivery==='object' && !Array.isArray(rawDelivery)?rawDelivery.reason:undefined).success?(rawDelivery as {reason:z.infer<typeof deliveryReason>}).reason:null},
    identity:'not-verified',runtimePolicy:manifest?.policyVersion??null,
    contract:{availability:contractAvailability,digest:contract?.digest??null,revision:contract?.revision??null,requiredChecks:contract?.contract.requiredChecks.length??null,humanReviewsPending:contract?.contract.humanReview.length??null,
      allowedWritePathReferences:contract?.contract.allowedWritePaths.map(file=>reference('path',file))??[],protectedPathReferences:contract?.contract.protectedFiles.map(file=>reference('path',file))??[],
      checks:contract?.contract.requiredChecks.map(check=>({reference:reference('check',check.id),argvDigest:'sha256:'+createHash('sha256').update(JSON.stringify([check.command,...check.args])).digest('hex'),kind:check.kind,backend:check.execution.backend,approval:check.execution.approval}))??[],humanReviewReferences:contract?.contract.humanReview.map(review=>reference('review',review.id))??[]},
    delivery:{availability:delivery?'recorded':rawDelivery===undefined?'unavailable':'invalid',status:delivery?.status??'unknown',
      patchId:delivery?.delivery?.patchId??null,snapshotDigest:delivery?.delivery?.snapshotDigest??null,
      interpretation:'recorded-checkpoint-not-current-workspace-verification',checks:(delivery?.checks??[]).filter(check=>check.runId===state.runId && check.contractDigest===contract?.digest && check.contractRevision===contract?.revision)
        .map(check=>({reference:reference('check',check.checkId),argvDigest:check.argvDigest,patchId:check.patchId,snapshotDigest:check.snapshotDigest,exitCode:check.exitCode,timedOut:check.timedOut,unchanged:check.unchanged}))},
    approvals,usage:{availability:usage?'recorded':'unavailable',calls:usage?.calls??null,inputTokens:usage?.inputTokens??null,outputTokens:usage?.outputTokens??null,
      complete:usage?.usageComplete??null,estimatedUsd:usage?.estimatedUsd??null,costKind:'estimate-not-invoice'},
    journal:{availability:journal?'recorded':'unavailable',entries:journal?.length??0,failed:journal?.filter(entry=>entry.status==='failed').length??0,
      unfinished:journal?.filter(entry=>entry.status!=='completed' && entry.status!=='failed').length??0},
    delegations:{availability:rawDelegations===undefined?'unavailable':delegations.success?'recorded':'invalid',interpretation:'recorded-checkpoint-not-semantic-review',
      items:delegations.success?delegations.data.evaluations.map(item=>({taskReference:reference('task',item.taskId),childReference:item.childRunId?reference('run',item.childRunId):null,
        recordedAcceptance:item.accepted,reason:item.reason,semanticReview:item.semanticReview,correctionsUsed:item.correctionsUsed??null})):[]},
    children:(state.childRuns??[]).slice(0,64).map(child=>reference('run',child.runId))};
}

/** Read-only store projection. Refuses concurrent revision changes and excessive journals. */
export async function exportHarnessGovernanceReport(store:AgentRunStore,scope:AgentStoreScope|undefined,runId:string,options:HarnessGovernanceOptions={}):Promise<HarnessGovernanceReport> {
  const limitations=new Set<HarnessGovernanceReport['limitations'][number]>();
  const runs:HarnessGovernanceReport['runs']=[],missingChildren:string[]=[];
  const observed:Array<{state:AgentRunState;journal:AgentToolCallJournalEntry[]|undefined}>=[];
  const queue:Array<{id:string;parent?:string}>=[{id:runId}],seen=new Set<string>();
  while(queue.length && runs.length+missingChildren.length<64) {
    const item=queue.shift()!;
    if(seen.has(item.id))continue;
    seen.add(item.id);
    const loaded=await store.load(item.id,scope);
    const state=loaded?structuredClone(loaded):undefined;
    if(!state || state.runId!==item.id || !sameScope(state,scope) || item.parent!==undefined && state.parentRunId!==item.parent) {
      if(item.parent===undefined)throw new Error('GOVERNANCE_RUN_UNAVAILABLE');
      missingChildren.push(reference('run',item.id));limitations.add('missing_child');continue;
    }
    const loadedJournal=await store.listToolCalls?.(state.runId,scope);
    const journal=loadedJournal?structuredClone(loadedJournal):undefined;
    if(journal && journal.length>MAX_JOURNAL)throw new Error('GOVERNANCE_JOURNAL_LIMIT');
    if(journal?.some(entry=>entry.runId!==state.runId))throw new Error('GOVERNANCE_JOURNAL_SCOPE');
    if(!journal)limitations.add('journal_unavailable');
    observed.push({state,journal});
    runs.push(projectRun(state,journal,limitations));
    if((state.childRuns?.length??0)>64)limitations.add('tree_limit');
    for(const child of (state.childRuns??[]).slice(0,64))queue.push({id:child.runId,parent:state.runId});
  }
  if(queue.length)limitations.add('tree_limit');
  const context=await readGovernanceSession(options.session,runId,new Set(observed.map(item=>item.state.runId)));
  // A report never invokes run-store save or a tool/model. Activity replay may apply its normal retention policy.
  for(const {state,journal} of observed) {
    const current=await store.load(state.runId,scope);
    const currentJournal=await store.listToolCalls?.(state.runId,scope);
    if(!current || JSON.stringify(current)!==JSON.stringify(state) || JSON.stringify(currentJournal)!==JSON.stringify(journal))throw new Error('GOVERNANCE_STATE_CHANGED');
  }
  await context.verify();
  const patches=new Map<string,string[]>();
  for(const run of runs)for(const patch of new Set([run.delivery.patchId,...run.approvals.items.map(row=>row.proposalId)].filter((id):id is string=>id!==null)))patches.set(patch,[...(patches.get(patch)??[]),run.reference]);
  const binding=bindingSchema.safeParse(observed[0]?.state.harness);
  const report=harnessGovernanceReportSchema.parse({schemaVersion:1,kind:'harness-governance-report',exporterVersion:HARNESS_VERSION,
    executionArtifact:{version:binding.success?binding.data.version:null,digest:null,availability:binding.success?'recorded-version':'unavailable',configurationFingerprint:binding.success?binding.data.fingerprint:null,authenticity:'not-verified'},rootReference:reference('run',runId),identity:'not-verified',
    referencePolicy:'sha256-domain-separated-pseudonyms-not-anonymity',session:context.session,eventHistory:context.history,changeEnvelopes:projectGovernanceEnvelopes(options.changeEnvelopes??[],patches,options.now??Date.now()),
    runs,missingChildren,limitations:[...limitations].sort()});
  if(Buffer.byteLength(JSON.stringify(report))>MAX_REPORT_BYTES)throw new Error('GOVERNANCE_REPORT_LIMIT');
  return report;
}

export function renderHarnessGovernanceMarkdown(input:unknown):string {
  const report=harnessGovernanceReportSchema.parse(input);
  return ['# Execution and governance report','',`Schema: ${report.schemaVersion}. Exporter: ${report.exporterVersion}.`,
    `Identity: not verified. Recorded execution version: ${report.executionArtifact.version??'unavailable'}. Artifact digest: unavailable. Hash references are pseudonyms, not signatures.`,
    'Delivery describes a recorded checkpoint; export does not recheck the workspace.','',
    '| Run reference | Execution | Recorded delivery | Usage |','| --- | --- | --- | --- |',
    ...report.runs.map(run=>`| ${run.reference} | ${run.status} | ${run.delivery.status} | ${run.usage.availability==='unavailable'?'unavailable':`${run.usage.inputTokens} input / ${run.usage.outputTokens} output (${run.usage.complete?'complete':'incomplete'})`} |`),
    '',`Missing children: ${report.missingChildren.length}. Limitations: ${report.limitations.join(', ')||'none detected'}.`,
    `Session: ${report.session.availability}. Event history: ${report.eventHistory.availability}. Retention: ${report.eventHistory.retention}. Incomplete: ${report.eventHistory.incomplete}.`,
    `Change envelopes: ${report.changeEnvelopes.length}. Envelope integrity does not verify patch bytes or authenticity. Estimates are not invoices.`,''].join('\n');
}
