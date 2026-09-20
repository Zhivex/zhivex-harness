import {z} from "zod";
import type {HarnessOciExecutionEnvironment} from "./execution-environment.js";
import type {AgentStoreScope} from "@zhivex-ai/core";
import {createEditProposal, editProposalInputSchema, fileDigestSchema, type ApplyEditProposalInput} from "./edit-contracts.js";
import type {ReplacementEdit} from "./replacement-edits.js";
import type {Workspace} from "./workspace.js";
import type {HarnessClientRun} from "./client-contract.js";
export interface ApprovalPreviewFile {path:string;expectedDigest:string|null;before:string|null;after:string|null;afterDigest:string|null;beforeMode?:number;afterMode?:number;operation?:"create"|"update"|"delete"}
export type ApprovalFilePreview = {status:"complete";proposalId:string;files:ApprovalPreviewFile[]}|{status:"unavailable"};
/** Explicitly requested read projection; never trusts renderer-supplied paths or changes. */
export async function attachApprovalPreviews(run:HarnessClientRun,workspace:Workspace,options:{environment?:HarnessOciExecutionEnvironment|undefined;scope?:AgentStoreScope|undefined}={}):Promise<HarnessClientRun>{
 let remaining=256*1024;
 for(const approval of run.approvals){
  const action=approval.action as {name?:unknown;arguments?:unknown}|null;
  if(!action||!["apply_patch","apply_reviewed_edits","apply_reviewed_replacement","apply_environment_patch","verify_and_apply_environment_patch","verify_and_apply_reviewed_edits"].includes(String(action.name)))continue;
  approval.filePreview={status:"unavailable"};
  try{
   if(typeof action.arguments!=="string"||Buffer.byteLength(action.arguments)>256*1024)continue;
   const args:unknown=JSON.parse(action.arguments);
   const preview=action.name==="apply_environment_patch"||action.name==="verify_and_apply_environment_patch"?await (async()=>{
    if(!options.environment)throw new Error("OCI_REVIEW_UNAVAILABLE");
    const patchId=fileDigestSchema.parse((args as {patchId?:unknown})?.patchId);
    const patch=await options.environment.previewPatch({runId:run.runId,...(options.scope?{scope:options.scope}:{})},patchId);
    return {proposalId:patch.patchId,files:patch.entries.map(entry=>({path:entry.path,expectedDigest:entry.beforeDigest??null,before:entry.beforeContent??null,after:entry.afterContent??null,afterDigest:entry.afterDigest??null,operation:entry.operation,...(entry.beforeMode===undefined?{}:{beforeMode:entry.beforeMode}),...(entry.afterMode===undefined?{}:{afterMode:entry.afterMode})}))};
   })():action.name==="verify_and_apply_reviewed_edits"?await (async()=>{
    if(!options.environment)throw new Error("OCI_REVIEW_UNAVAILABLE");
    const {changes}=editProposalInputSchema.extend({command:z.string().min(1),args:z.array(z.string()).default([])}).parse(args);
    return workspace.previewPatch({changes,proposalId:createEditProposal({changes}).proposalId});
   })():action.name==="apply_reviewed_replacement"?await workspace.previewReplacement(args as ReplacementEdit)
    :action.name==="apply_patch"?await workspace.previewPatch(args as ApplyEditProposalInput)
    :await (async()=>{const {changes}=editProposalInputSchema.parse(args);return workspace.previewPatch({changes,proposalId:createEditProposal({changes}).proposalId});})();
   const bytes=Buffer.byteLength(JSON.stringify(preview));if(bytes>remaining)continue;
   remaining-=bytes;approval.filePreview={status:"complete",...preview};
  }catch{/* A stale, protected or unrenderable base must not disclose file/error contents. */}
 }
 return run;
}
