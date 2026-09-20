import {createHash} from "node:crypto";
import {z} from "zod";
import type {AgentRunState,AgentToolCallJournalEntry} from "@zhivex-ai/core";
export const APPROVAL_HISTORY_KEY="clientApprovalDecisionsV1";
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value&&typeof value==="object"?`{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`:JSON.stringify(value)??"null";
export const approvalInputDigest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const rowSchema=z.object({approvalId:z.string().max(256),digest:z.string().regex(/^[a-f0-9]{64}$/),toolCallId:z.string().max(256).optional(),name:z.string().max(256),inputDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),approved:z.boolean(),decidedAt:z.number().int().nonnegative(),reviewedRevision:z.number().int().nonnegative()}).strict();
export type ApprovalDecisionRecord=z.infer<typeof rowSchema>;
export interface ApprovalDecisionView extends ApprovalDecisionRecord {
 status:"rejected"|"approved"|"applied"|"succeeded"|"failed"|"unknown";
 evidence?:{journalRevision:number;completedAt?:number;exitCode?:number;timedOut?:boolean;proposalId?:string;effects?:Array<{path:string;beforeDigest:string|null;afterDigest:string|null}>};
}
export function readApprovalDecisions(state:AgentRunState):ApprovalDecisionRecord[]{
 const value=state.metadata?.[APPROVAL_HISTORY_KEY];if(value===undefined)return [];
 return z.array(rowSchema).max(512).parse(value);
}
export function approvalDecisionViews(state:AgentRunState,journal:readonly AgentToolCallJournalEntry[],offset=0):ApprovalDecisionView[]{
 return readApprovalDecisions(state).slice(offset,offset+25).map(row=>{
  if(!row.approved)return {...row,status:"rejected"};
  const entry=journal.find(entry=>entry.runId===state.runId&&entry.providerToolCallId===row.toolCallId&&entry.toolName===row.name&&row.inputDigest!==undefined&&approvalInputDigest(entry.input)===row.inputDigest);
  if(!entry)return {...row,status:["created","running","waiting_approval","cancel_requested"].includes(state.status)?"approved":"unknown"};
  const evidence:NonNullable<ApprovalDecisionView["evidence"]>={journalRevision:entry.revision,...(entry.completedAt===undefined?{}:{completedAt:entry.completedAt})};
  if(entry.status==="failed")return {...row,status:"failed",evidence};
  if(entry.status!=="completed")return {...row,status:"unknown",evidence};
  const out=entry.output&&typeof entry.output==="object"&&!Array.isArray(entry.output)?entry.output:{};
  if(row.name==="run_check"){
   if(typeof out.exitCode!=="number"||!Number.isInteger(out.exitCode))return {...row,status:"unknown",evidence};
   evidence.exitCode=out.exitCode;if(typeof out.timedOut==="boolean")evidence.timedOut=out.timedOut;
   return {...row,status:out.exitCode===0&&!out.timedOut?"succeeded":"failed",evidence};
  }
  if(["apply_patch","apply_reviewed_edits","apply_reviewed_replacement"].includes(row.name)){
   const receipt=z.object({kind:z.literal("patch-result"),result:z.object({proposalId:z.string().regex(/^sha256:[a-f0-9]{64}$/),changes:z.array(z.object({path:z.string().max(1024),beforeDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),afterDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()})).min(1).max(50)})}).safeParse(out);
   if(!receipt.success)return {...row,status:"unknown",evidence};
   evidence.proposalId=receipt.data.result.proposalId;evidence.effects=receipt.data.result.changes.map(change=>({...change,beforeDigest:change.beforeDigest??null}));
   return {...row,status:"applied",evidence};
  }
  return {...row,status:"succeeded",evidence};
 });
}
