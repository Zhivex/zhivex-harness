import {randomUUID} from "node:crypto";
import type {ApprovalReview} from "./approval-review.js";
/** Main-process receipts: renderer supplies only an opaque ticket and a boolean decision. */
export class ReviewTickets {
 private readonly entries=new Map<string,{sessionId:string;review:ApprovalReview}>();
 issue(sessionId:string,review:ApprovalReview){
  const ticketId=randomUUID();
  this.entries.set(ticketId,{sessionId,review:structuredClone(review)});
  while(this.entries.size>128)this.entries.delete(this.entries.keys().next().value!);
  // Positive decisions require a complete host projection for a supported tool.
  return {...review,ticketId,canApprove:review.items.length>0&&review.items.every(item=>item.complete&&["run_check","apply_patch","apply_reviewed_edits","apply_reviewed_replacement","apply_environment_patch","verify_and_apply_environment_patch","verify_and_apply_reviewed_edits"].includes(item.name))};
 }
 consume(ticketId:unknown,approve:unknown,now=Date.now()){
  if(typeof ticketId!=="string"||typeof approve!=="boolean")throw new Error("INVALID_DECISION");
  const entry=this.entries.get(ticketId);if(!entry)throw new Error("REVIEW_REQUIRED");
  const {sessionId,review}=entry;
  if(!review.items.length||review.items.some(item=>item.expiresAt<=now)){this.entries.delete(ticketId);throw new Error("REVIEW_EXPIRED");}
  if(approve&&review.items.some(item=>!item.complete||!["run_check","apply_patch","apply_reviewed_edits","apply_reviewed_replacement","apply_environment_patch","verify_and_apply_environment_patch","verify_and_apply_reviewed_edits"].includes(item.name)))throw new Error("REVIEW_INCOMPLETE");
  // Consume before transport: an uncertain response must be reconciled, never blindly replayed.
  this.entries.delete(ticketId);
  return {method:"approval.resolve" as const,sessionId,runId:review.runId,expectedRevision:review.revision,idempotencyKey:`review_${ticketId}`,decisions:review.items.map(item=>({approvalId:item.approvalId,digest:item.digest,approve}))};
 }
}
export type TicketedApprovalReview=ReturnType<ReviewTickets["issue"]>;
