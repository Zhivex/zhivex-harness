import {z} from 'zod';
import {serializeJsonValue, type AgentRunState, type AgentRunStore, type AgentStoreScope, type ToolExecutionResult} from '@zhivex-ai/core';
import type {HarnessDelegationContract} from './delegation-contracts.js';

const file=z.string().min(1).max(1024).refine(value=>!value.startsWith('/') && !/[\\\\:\u0000-\u001f]/.test(value) && value.split('/').every(part=>part!=='' && part!=='.' && part!=='..'));
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier=z.string().min(1).max(512);
const line=z.number().int().positive();
const range={toolCallId:identifier,startLine:line,endLine:line};
const evidence=z.strictObject(range).refine(value=>value.endLine>=value.startLine);
const reference=z.strictObject({path:file,...range}).refine(value=>value.endLine>=value.startLine);
export const delegationResultContractSchema=z.strictObject({
  schemaVersion:z.literal(1),requiredReadPaths:z.array(file).min(1).max(32),
  humanReviewRequired:z.boolean(),maxCorrections:z.number().int().min(0).max(2)
});
export type DelegationResultContract=Readonly<Omit<z.infer<typeof delegationResultContractSchema>,'requiredReadPaths'>&{requiredReadPaths:readonly string[]}>;
export const delegationResultSchema=z.strictObject({
  schemaVersion:z.literal(1),taskId:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),status:z.enum(['completed','incomplete']),
  inspectedFiles:z.array(z.strictObject({path:file,digest,evidence:z.array(evidence).min(1).max(128)})).max(32),
  findings:z.array(z.strictObject({id:z.string().min(1).max(128),message:z.string().min(1).max(4000),evidence:z.array(reference).min(1).max(32)})).max(32)
});
export type DelegationResult=z.infer<typeof delegationResultSchema>;
const readReceipt=z.object({path:file,digest,startLine:line,endLine:line,totalLines:line,clippedLine:z.boolean()})
  .refine(value=>value.endLine>=value.startLine && value.endLine<=value.totalLines);
type Receipt=z.infer<typeof readReceipt>;
export type DelegationAcceptanceReason='valid'|'invalid_json'|'invalid_schema'|'task_mismatch'|'incomplete'|'duplicate_claim'|'path_denied'|'evidence_missing'|'coverage_missing';
export interface DelegationAcceptance {
  schemaVersion:1;taskId:string;accepted:boolean;reason:DelegationAcceptanceReason;
  semanticReview:'pending'|'not_requested';
  result?:DelegationResult;
}

/** Receipts must come from the host's child state, never from the declared result. */
export function validateDelegationResult(contract:HarnessDelegationContract,text:string,toolResults:readonly ToolExecutionResult[]):DelegationAcceptance {
  if(!contract.resultContract)throw new Error('DELEGATION_RESULT_CONTRACT_REQUIRED');
  const base={schemaVersion:1 as const,taskId:contract.taskId,semanticReview:contract.resultContract.humanReviewRequired?'pending' as const:'not_requested' as const};
  const reject=(reason:DelegationAcceptanceReason):DelegationAcceptance=>({...base,accepted:false,reason});
  if(Buffer.byteLength(text)>64*1024)return reject('invalid_schema');
  let raw:unknown;try{raw=JSON.parse(text);}catch{return reject('invalid_json');}
  const parsed=delegationResultSchema.safeParse(raw);
  if(!parsed.success)return reject('invalid_schema');
  const result=parsed.data;
  if(result.taskId!==contract.taskId)return reject('task_mismatch');
  if(result.status!=='completed')return reject('incomplete');
  if(new Set(result.inspectedFiles.map(item=>item.path)).size!==result.inspectedFiles.length || new Set(result.findings.map(item=>item.id)).size!==result.findings.length)return reject('duplicate_claim');
  if(result.inspectedFiles.some(item=>!contract.allowedReadPaths.includes(item.path)))return reject('path_denied');
  const receipts=new Map<string,Receipt>(),seen=new Set<string>(),ambiguous=new Set<string>();
  for(const row of toolResults) {
    if(seen.has(row.toolCallId))ambiguous.add(row.toolCallId);
    seen.add(row.toolCallId);
    if(row.toolName!=='read_file' || row.isError)continue;
    const read=readReceipt.safeParse(row.output);
    if(read.success && !read.data.clippedLine)receipts.set(row.toolCallId,read.data);
  }
  const files=new Map(result.inspectedFiles.map(item=>[item.path,item]));
  const supports=(path:string,ref:z.infer<typeof evidence>)=>{
    const receipt=receipts.get(ref.toolCallId),declared=files.get(path);
    return !ambiguous.has(ref.toolCallId) && receipt && declared && receipt.path===path && receipt.digest===declared.digest &&
      ref.startLine>=receipt.startLine && ref.endLine<=receipt.endLine;
  };
  for(const inspected of result.inspectedFiles) {
    if(inspected.evidence.some(ref=>!supports(inspected.path,ref)))return reject('evidence_missing');
    const totals=new Set(inspected.evidence.map(ref=>receipts.get(ref.toolCallId)!.totalLines));
    if(totals.size!==1)return reject('evidence_missing');
  }
  for(const finding of result.findings)if(finding.evidence.some(ref=>!supports(ref.path,ref)))return reject('evidence_missing');
  for(const path of contract.resultContract.requiredReadPaths) {
    const inspected=files.get(path);if(!inspected)return reject('coverage_missing');
    let covered=0;
    for(const ref of [...inspected.evidence].sort((a,b)=>a.startLine-b.startLine)) {
      if(ref.startLine>covered+1)return reject('coverage_missing');
      covered=Math.max(covered,ref.endLine);
    }
    if(covered!==receipts.get(inspected.evidence[0]!.toolCallId)!.totalLines)return reject('coverage_missing');
  }
  return {...base,accepted:true,reason:'valid',result};
}

/** SDK outputText can concatenate narration from earlier tool steps; the final response owns the result. */
export const delegationTerminalText = (state: Pick<AgentRunState, 'steps' | 'outputText'>): string =>
  state.steps.at(-1)?.response?.text ?? state.outputText;

/** Parent independently checks durable child evidence rather than trusting the child's prose. */
export async function inspectDelegatedResults(state:AgentRunState,contracts:readonly HarnessDelegationContract[],store:AgentRunStore,defaultScope?:AgentStoreScope) {
  const scope=state.scope??defaultScope;
  const evaluations=[];
  for(const contract of contracts.filter(item=>item.resultContract)) {
    const children=(state.childRuns??[]).filter(child=>child.toolName===`delegate_${contract.profile}`);
    if(!children.length)evaluations.push({taskId:contract.taskId,childRunId:null,childStatus:'missing',accepted:false,reason:'missing_child',semanticReview:contract.resultContract!.humanReviewRequired?'pending':'not_requested'});
    for(const child of children) {
      const durable=await store.load(child.runId,scope);
      const validIdentity=durable?.runId===child.runId && durable.parentRunId===state.runId &&
        ['tenantId','userId','namespace'].every(key=>durable.scope?.[key as keyof AgentStoreScope]===scope?.[key as keyof AgentStoreScope]);
      const acceptance=validIdentity?validateDelegationResult(contract,delegationTerminalText(durable),durable.toolResults):undefined;
      evaluations.push({taskId:contract.taskId,childRunId:child.runId,childStatus:durable?.status??'missing',
        accepted:durable?.status==='completed' && child.status==='completed' && acceptance?.accepted===true,
        correctionsUsed:durable?.toolResults.filter(result=>result.toolName==='__harness_result_feedback').length??0,
        reason:acceptance?.reason??'child_identity_unavailable',semanticReview:acceptance?.semanticReview??'pending'});
    }
  }
  state.metadata={...state.metadata,zhivexDelegationAcceptanceV1:serializeJsonValue({schemaVersion:1,evaluations})};
  return evaluations;
}

/** Persist host-computed observations even when output guardrails receive SDK copies. */
export function delegationAcceptanceStore(store:AgentRunStore,contracts:readonly HarnessDelegationContract[],scope:AgentStoreScope):AgentRunStore {
  if(!contracts.some(contract=>contract.resultContract))return store;
  return new Proxy(store,{get(target,key){
    if(key==='save')return async(...args:Parameters<AgentRunStore['save']>)=>{
      const [state]=args;
      if(!state.parentRunId)await inspectDelegatedResults(state,contracts,target,scope);
      return target.save(...args);
    };
    const value:unknown=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
}
