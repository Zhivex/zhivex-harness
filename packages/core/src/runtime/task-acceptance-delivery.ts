import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { AgentRunState, AgentToolCallJournalEntry } from '@zhivex-ai/core';
import type { TaskAcceptanceLedger } from './task-acceptance-record.js';
import { createTaskAcceptanceChecks, type TaskCheckBinding } from './task-acceptance-checks.js';

interface DeliveryScope {
  workspace:string; revision:number; digest:string; allowed:Set<string>; protected:Set<string>;
  checks:ReturnType<typeof createTaskAcceptanceChecks>;
  previousDelivery?:TaskCheckBinding;
  imported?:{binding:TaskCheckBinding;validate:()=>Promise<boolean>};
  violation?:{code:'TASK_ACCEPTANCE_SCOPE_VIOLATION';runId:string;patchId:string;paths:string[]};
}
const scopes=new AsyncLocalStorage<DeliveryScope>();

/** Internal host authority, inherited by bounded child execution; never populated from tool input. */
export function withTaskAcceptanceDelivery<T>(workspace:string,ledger:TaskAcceptanceLedger,work:()=>Promise<T>,previousEvidence?:unknown,journal:readonly AgentToolCallJournalEntry[]=[]):Promise<T> {
  const latest=ledger.revisions.at(-1)!;
  const previous=z.object({contractDigest:z.literal(latest.digest),contractRevision:z.literal(latest.revision),diagnostic:z.strictObject({
    code:z.literal('TASK_ACCEPTANCE_SCOPE_VIOLATION'),runId:z.string().max(512),patchId:z.string().regex(/^sha256:[a-f0-9]{64}$/),paths:z.array(z.string().max(1024)).max(256)
  })}).safeParse(previousEvidence);
  const previousDelivery=z.object({contractDigest:z.literal(latest.digest),contractRevision:z.literal(latest.revision),delivery:z.strictObject({
    runId:z.string().min(1).max(512),executionIdentity:z.string().min(1).max(512),patchId:z.string().regex(/^sha256:[a-f0-9]{64}$/),snapshotDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })}).safeParse(previousEvidence);
  return scopes.run({...(previousDelivery.success?{previousDelivery:previousDelivery.data.delivery}:{}),workspace,revision:latest.revision,digest:latest.digest,
    checks:createTaskAcceptanceChecks(ledger,previousEvidence && typeof previousEvidence==='object' && 'checks'in previousEvidence?previousEvidence.checks:[],journal),
    allowed:new Set(latest.contract.allowedWritePaths),protected:new Set(latest.contract.protectedFiles.map(file=>file.toLowerCase())),
    ...(previous.success?{violation:previous.data.diagnostic}:{})},work);
}

/** Called on the freshly recomputed exact patch while holding the host mutation lock. */
export function assertTaskAcceptanceImport(input:{workspace:string;runId:string;patchId:string;executionIdentity?:string;snapshotDigest?:string;entries:readonly {path:string;operation:'create'|'update'|'delete'}[]}):void {
  const scope=scopes.getStore();
  if(!scope)return;
  const blocked=input.entries.filter(entry=>{
    const candidate=entry.path.toLowerCase();
    return input.workspace!==scope.workspace || !scope.allowed.has(entry.path) || [...scope.protected].some(file=>candidate===file || candidate.startsWith(file+'/') || file.startsWith(candidate+'/'));
  });
  if(blocked.length) {
    scope.violation={code:'TASK_ACCEPTANCE_SCOPE_VIOLATION',runId:input.runId,patchId:input.patchId,paths:blocked.map(entry=>entry.path).slice(0,256)};
    throw new Error('TASK_ACCEPTANCE_SCOPE_VIOLATION: the OCI patch touches files outside the task contract; no host import was performed.');
  }
  if(!input.executionIdentity || !input.snapshotDigest || scope.checks.missing({runId:input.runId,patchId:input.patchId,executionIdentity:input.executionIdentity,snapshotDigest:input.snapshotDigest}).length) {
    throw new Error('TASK_ACCEPTANCE_CHECKS_MISSING: every required check must succeed on the exact final snapshot and patch before import.');
  }
}

export const taskAcceptanceChecks=()=>scopes.getStore()?.checks;

export function taskAcceptanceDeliveryDiagnostic(digest:string,revision:number) {
  const scope=scopes.getStore();
  return scope?.digest===digest && scope.revision===revision && scope.violation?structuredClone(scope.violation):undefined;
}

/** The execution adapter calls this only after all host effects have succeeded. */
export function confirmTaskAcceptanceImport(binding:TaskCheckBinding,validate:()=>Promise<boolean>):void {
  const scope=scopes.getStore();
  if(scope)scope.imported={binding:structuredClone(binding),validate};
}

/** Additive acceptance outcome; never rewrites the SDK run status. */
async function evaluateTaskAcceptanceOutcome(state:Pick<AgentRunState,'runId'|'status'|'finishReason'>,ledger:TaskAcceptanceLedger) {
  const current=ledger.revisions.at(-1)!,scope=scopes.getStore();
  const terminal=['completed','failed','cancelled','timed_out'].includes(state.status);
  if(!scope || scope.digest!==current.digest || scope.revision!==current.revision) {
    return {status:terminal?'incomplete':'pending',reason:'TASK_ACCEPTANCE_NO_DELIVERY_EVIDENCE'};
  }
  if(scope.violation)return {status:'failed',reason:scope.violation.code};
  if(state.status!=='completed')return {status:state.status==='failed'?'failed':terminal?'incomplete':'pending',reason:'TASK_ACCEPTANCE_RUN_NOT_COMPLETED'};
  if(state.finishReason!=='stop')return {status:'incomplete',reason:'TASK_ACCEPTANCE_RUN_NOT_FINISHED'};
  const imported=scope.imported;
  if(!imported || imported.binding.runId!==state.runId)return {status:'incomplete',reason:'TASK_ACCEPTANCE_IMPORT_UNCONFIRMED'};
  const delivery={...imported.binding};
  if(scope.checks.missing(delivery).length)return {status:'incomplete',reason:'TASK_ACCEPTANCE_CHECKS_MISSING',delivery};
  try {
    if(!await imported.validate())return {status:'incomplete',reason:'TASK_ACCEPTANCE_DELIVERY_DRIFT',delivery};
  } catch {return {status:'incomplete',reason:'TASK_ACCEPTANCE_DELIVERY_INSPECTION_FAILED',delivery};}
  return {status:current.contract.humanReview.length?'pending_review':'verified',reason:current.contract.humanReview.length?'TASK_ACCEPTANCE_HUMAN_REVIEW_REQUIRED':'TASK_ACCEPTANCE_VERIFIED',delivery};
}

export async function taskAcceptanceOutcome(state:Pick<AgentRunState,'runId'|'status'|'finishReason'>,ledger:TaskAcceptanceLedger) {
  const outcome=await evaluateTaskAcceptanceOutcome(state,ledger);
  const scope=scopes.getStore(),latest=ledger.revisions.at(-1)!;
  const delivery=scope?.digest===latest.digest && scope.revision===latest.revision?(scope.imported?.binding??scope.previousDelivery):undefined;
  return {...outcome,...(delivery && delivery.runId===state.runId?{delivery:structuredClone(delivery)}:{})};
}
