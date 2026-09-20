import {expect,test} from "bun:test";
import type {AgentRunState,AgentToolCallJournalEntry} from "@zhivex-ai/core";
import {APPROVAL_HISTORY_KEY,approvalInputDigest,approvalDecisionViews} from "../src/approval-history.js";
const input={check:"test",expectedScript:"bun test"};
const row={approvalId:"a",digest:"a".repeat(64),toolCallId:"provider-call",name:"run_check",inputDigest:approvalInputDigest(input),approved:true,decidedAt:100,reviewedRevision:2};
const state=(record=row)=>({runId:"run",status:"completed",metadata:{[APPROVAL_HISTORY_KEY]:[record]}} as unknown as AgentRunState);
const journal=(override:Partial<AgentToolCallJournalEntry>={}):AgentToolCallJournalEntry=>({runId:"run",toolCallId:"journal-call",providerToolCallId:"provider-call",toolName:"run_check",status:"completed",idempotencyKey:"unique",revision:3,updatedAt:101,input,output:{exitCode:0,timedOut:false,stdout:"private output"},...override});
test("approval is not success: requires matching run, call, name, input and check receipt",()=>{
 expect(approvalDecisionViews(state(),[])[0]!.status).toBe("unknown");
 for(const override of [{runId:"other"},{providerToolCallId:"other"},{toolName:"other"},{input:{check:"other"}},{output:{}}])expect(approvalDecisionViews(state(),[journal(override)])[0]!.status).toBe("unknown");
 expect(approvalDecisionViews(state(),[journal()])[0]).toMatchObject({status:"succeeded",evidence:{exitCode:0}});
 expect(approvalDecisionViews(state(),[journal({output:{exitCode:7}})])[0]!.status).toBe("failed");
 expect(approvalDecisionViews(state(),[journal({output:{exitCode:0,timedOut:true}})])[0]!.status).toBe("failed");
 expect(JSON.stringify(approvalDecisionViews(state(),[journal()]))).not.toContain("private output");
 expect(approvalDecisionViews(state({...row,approved:false}),[journal()])[0]!.status).toBe("rejected");
});
test("file applied status requires a bounded patch receipt rather than tool or run completion alone",()=>{
 const record={...row,name:"apply_patch"};
 expect(approvalDecisionViews(state(record),[journal({toolName:"apply_patch",output:{}})])[0]!.status).toBe("unknown");
 const result=approvalDecisionViews(state(record),[journal({toolName:"apply_patch",output:{kind:"patch-result",result:{proposalId:"sha256:"+"b".repeat(64),changes:[{path:"new.txt",afterDigest:"sha256:"+"c".repeat(64)}]}}})]);
 expect(result[0]).toMatchObject({status:"applied",evidence:{effects:[{path:"new.txt",beforeDigest:null}]}});
});

test("history projects bounded pages without dropping the durable ledger",()=>{
 const records=Array.from({length:52},(_,i)=>({...row,approvalId:`a${i}`,approved:false}));
 const run={...state(),metadata:{[APPROVAL_HISTORY_KEY]:records}} as unknown as AgentRunState;
 expect(approvalDecisionViews(run,[])).toHaveLength(25);
 expect(approvalDecisionViews(run,[],25)[0]!.approvalId).toBe("a25");
 expect(approvalDecisionViews(run,[],50).map(r=>r.approvalId)).toEqual(["a50","a51"]);
});
