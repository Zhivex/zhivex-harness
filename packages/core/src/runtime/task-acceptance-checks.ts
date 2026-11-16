import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentToolCallJournalEntry } from '@zhivex-ai/core';
import type { TaskAcceptanceLedger } from './task-acceptance-record.js';
const sha=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskCheckReceiptSchema=z.strictObject({schemaVersion:z.literal(1),checkId:z.string().max(128),contractDigest:sha,contractRevision:z.number().int().positive(),
  runId:z.string().max(512),executionIdentity:z.string().max(512),patchId:sha,snapshotDigest:sha,argvDigest:sha,
  exitCode:z.number().int(),timedOut:z.boolean(),unchanged:z.boolean(),
  source:z.strictObject({id:z.string().min(1).max(512),name:z.string().min(1).max(128),startedAt:z.number().finite().nonnegative().optional()}).optional()});
export type TaskCheckReceipt=z.infer<typeof taskCheckReceiptSchema>;
const argvDigest=(command:string,args:readonly string[])=>'sha256:'+createHash('sha256').update(JSON.stringify([command,...args])).digest('hex');
export interface TaskCheckBinding {runId:string;executionIdentity:string;patchId:string;snapshotDigest:string}

/** Private collector accepts host-observed results only, never model/tool-returned claims. */
export function createTaskAcceptanceChecks(ledger:TaskAcceptanceLedger,previous:unknown=[],journal:readonly AgentToolCallJournalEntry[]=[]) {
  const current=ledger.revisions.at(-1)!;
  const receipts=new Map<string,TaskCheckReceipt>();
  const parsed=z.array(taskCheckReceiptSchema).max(32).safeParse(previous);
  if(parsed.success)for(const receipt of parsed.data) {
    const check=current.contract.requiredChecks.find(c=>c.id===receipt.checkId);
    if(check && receipt.contractDigest===current.digest && receipt.contractRevision===current.revision && receipt.argvDigest===argvDigest(check.command,check.args) && reconciledReceipt(receipt,journal))receipts.set(check.id,receipt);
  }
  return {
    matching(command:string,args:readonly string[]) {return current.contract.requiredChecks.filter(check=>argvDigest(check.command,check.args)===argvDigest(command,args));},
    begin(checkIds:readonly string[]) {for(const id of checkIds)receipts.delete(id);},
    record(checkId:string,before:TaskCheckBinding,after:TaskCheckBinding,result:{exitCode:number;timedOut:boolean},source?:{id:string;name:string;startedAt?:number}) {
      const check=current.contract.requiredChecks.find(c=>c.id===checkId);
      if(!check)throw new Error('TASK_ACCEPTANCE_UNKNOWN_CHECK');
      const receipt=taskCheckReceiptSchema.parse({schemaVersion:1,checkId,contractDigest:current.digest,contractRevision:current.revision,...before,
        ...(source?{source:{id:source.id,name:source.name,...(source.startedAt!==undefined?{startedAt:source.startedAt}:{})}}:{}),argvDigest:argvDigest(check.command,check.args),exitCode:result.exitCode,timedOut:result.timedOut,
        unchanged:before.runId===after.runId && before.executionIdentity===after.executionIdentity && before.patchId===after.patchId && before.snapshotDigest===after.snapshotDigest});
      receipts.set(checkId,receipt);
      return structuredClone(receipt);
    },
    missing(binding:TaskCheckBinding) {
      return current.contract.requiredChecks.filter(check=>{
        const receipt=receipts.get(check.id);
        return !receipt || receipt.exitCode!==0 || receipt.timedOut || !receipt.unchanged ||
          receipt.runId!==binding.runId || receipt.executionIdentity!==binding.executionIdentity || receipt.patchId!==binding.patchId || receipt.snapshotDigest!==binding.snapshotDigest;
      }).map(check=>check.id);
    },
    snapshot(){return [...receipts.values()].map(receipt=>structuredClone(receipt));}
  };
}

const object=(value:unknown):Record<string,unknown>|undefined=>value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:undefined;
const commandDigest=(value:unknown):string|undefined=>{
  const input=object(value);
  return typeof input?.command==='string' && Array.isArray(input.args) && input.args.every(arg=>typeof arg==='string')
    ?argvDigest(input.command,input.args):undefined;
};

/** Recovery trusts completed journal observations, never a checkpoint alone. Ambiguity invalidates, it does not replay effects. */
function reconciledReceipt(receipt:TaskCheckReceipt,journal:readonly AgentToolCallJournalEntry[]):boolean {
  if(!receipt.source)return false;
  const matches=journal.filter(row=>row.runId===receipt.runId && row.providerToolCallId===receipt.source!.id && row.toolName===receipt.source!.name);
  if(matches.length!==1)return false;
  const row=matches[0]!;
  const startedAt=receipt.source.startedAt??row.startedAt;
  if(row.status!=='completed' || !Number.isFinite(startedAt) || !Number.isFinite(row.completedAt) || row.completedAt!<startedAt!)return false;
  // Batch aggregate output cannot prove the result of an individual command after interruption.
  if(!['run_environment_command','run_check','verify_and_apply_environment_patch','verify_and_apply_reviewed_edits'].includes(row.toolName))return false;
  const output=object(row.output),result=object(output?.verification)??output;
  if(!result || result.exitCode!==receipt.exitCode || result.timedOut!==receipt.timedOut || !Array.isArray(result.command) ||
    !result.command.every(arg=>typeof arg==='string') || typeof result.command[0]!=='string' ||
    argvDigest(result.command[0],result.command.slice(1) as string[])!==receipt.argvDigest)return false;
  if(row.toolName!=='run_check' && commandDigest(row.input)!==receipt.argvDigest)return false;
  for(const attempt of journal) {
    if(attempt===row || attempt.runId!==receipt.runId)continue;
    // An unfinished effect may have invalidated the snapshot after the last durable checkpoint.
    if(attempt.status==='pending' || attempt.status==='running')return false;
    const input=object(attempt.input);
    const sameCheck=commandDigest(input)===receipt.argvDigest ||
      (attempt.toolName==='run_check' && row.toolName==='run_check' && input?.check===object(row.input)?.check) ||
      (attempt.toolName==='run_environment_batch' && Array.isArray(input?.commands) && input.commands.some(command=>commandDigest(command)===receipt.argvDigest));
    if(sameCheck && (!Number.isFinite(attempt.completedAt) || attempt.completedAt!>=startedAt!))return false;
  }
  return true;
}
