import {createEditProposal, editProposalInputSchema, type ApplyEditProposalInput} from "./edit-contracts.js";
import type {ReplacementEdit} from "./replacement-edits.js";
import type {Workspace} from "./workspace.js";
import type {HarnessClientRun} from "./client-contract.js";
export type ApprovalFilePreview = {status:"complete";proposalId:string;files:Awaited<ReturnType<Workspace["previewPatch"]>>["files"]}|{status:"unavailable"};
/** Explicitly requested read projection; never trusts renderer-supplied paths or changes. */
export async function attachApprovalPreviews(run:HarnessClientRun,workspace:Workspace):Promise<HarnessClientRun>{
 let remaining=256*1024;
 for(const approval of run.approvals){
  const action=approval.action as {name?:unknown;arguments?:unknown}|null;
  if(!action||!["apply_patch","apply_reviewed_edits","apply_reviewed_replacement"].includes(String(action.name)))continue;
  approval.filePreview={status:"unavailable"};
  try{
   if(typeof action.arguments!=="string"||Buffer.byteLength(action.arguments)>256*1024)continue;
   const args:unknown=JSON.parse(action.arguments);
   const preview=action.name==="apply_reviewed_replacement"?await workspace.previewReplacement(args as ReplacementEdit)
    :action.name==="apply_patch"?await workspace.previewPatch(args as ApplyEditProposalInput)
    :await (async()=>{const {changes}=editProposalInputSchema.parse(args);return workspace.previewPatch({changes,proposalId:createEditProposal({changes}).proposalId});})();
   const bytes=Buffer.byteLength(JSON.stringify(preview));if(bytes>remaining)continue;
   remaining-=bytes;approval.filePreview={status:"complete",...preview};
  }catch{/* A stale, protected or unrenderable base must not disclose file/error contents. */}
 }
 return run;
}
