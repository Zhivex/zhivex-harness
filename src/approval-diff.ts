import {createHash} from "node:crypto";
import {z} from "zod";
import type {AgentRunState} from "@zhivex-ai/core";
import type {HarnessClientRun} from "./client-contract.js";
import type {ApprovalDecisionView} from "./approval-history.js";
export const APPROVAL_DIFFS_KEY="clientApprovalDiffsV1";
const sha=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const file=z.object({path:z.string().max(1024),expectedDigest:sha.nullable(),before:z.string().nullable(),after:z.string().nullable(),afterDigest:sha.nullable(),beforeMode:z.number().int().optional(),afterMode:z.number().int().optional(),operation:z.enum(["create","update","delete"]).optional()}).strict();
const archive=z.object({approvalId:z.string().max(256),digest:z.string().regex(/^[a-f0-9]{64}$/),proposalId:sha,files:z.array(file).min(1).max(50)}).strict();
const archives=z.array(archive).max(512);
export type AppliedDiff={status:"complete";files:z.infer<typeof file>[];redacted?:boolean}|{status:"unavailable"};
const maxBytes=2*1024*1024;
const contentDigest=(content:string|null)=>content===null?null:`sha256:${createHash("sha256").update(content).digest("hex")}`;
function read(state:AgentRunState){
 const value=state.metadata?.[APPROVAL_DIFFS_KEY]??[];
 if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new Error("APPROVAL_DIFF_LIMIT");
 return archives.parse(value);
}
/** Capture complete previews before admitting execution, bounded across the run. */
export function captureApprovalDiffs(state:AgentRunState,run:HarnessClientRun,approved:ReadonlySet<string>){
 const result=read(state);
 for(const item of run.approvals){
  if(!approved.has(item.approvalId)||item.filePreview?.status!=="complete")continue;
  const parsed=archive.safeParse({approvalId:item.approvalId,digest:item.digest,proposalId:item.filePreview.proposalId,files:item.filePreview.files});
  if(!parsed.success||result.length>=512)continue;
  const next=[...result,parsed.data];if(Buffer.byteLength(JSON.stringify(next))>maxBytes)continue;
  result.push(parsed.data);
 }
 return result;
}
/** Only expose saved content when exact journal effects certify every file. */
export function attachAppliedDiffs(state:AgentRunState,decisions:ApprovalDecisionView[]):ApprovalDecisionView[]{
 let saved:z.infer<typeof archives>;try{saved=read(state);}catch{saved=[];}
 return decisions.map(row=>{
  if(row.status!=="applied")return row;
  const missing:ApprovalDecisionView={...row,finalDiff:{status:"unavailable"}};
  const entry=saved.find(item=>item.approvalId===row.approvalId&&item.digest===row.digest);
  const effects=row.evidence?.effects;
  if(!entry||!effects||entry.proposalId!==(row.evidence?.reviewedProposalId??row.evidence?.proposalId)||entry.files.length!==effects.length)return missing;
  if(new Set(entry.files.map(file=>file.path)).size!==entry.files.length||new Set(effects.map(effect=>effect.path)).size!==effects.length)return missing;
  if(entry.files.some(file=>{
   const effect=effects.find(effect=>effect.path===file.path);
   return !effect||effect.beforeDigest!==file.expectedDigest||effect.afterDigest!==file.afterDigest||contentDigest(file.before)!==file.expectedDigest||contentDigest(file.after)!==file.afterDigest;
  }))return missing;
  return {...row,finalDiff:{status:"complete",files:entry.files}};
 });
}
