import {test,expect} from "bun:test";
import {projectApprovalReview} from "../src/approval-review.js";
import type {HarnessClientRun} from "../../src/client-contract.js";
const run=(name:string,args:unknown):HarnessClientRun=>({runId:"run_fixture",revision:7,status:"waiting_approval",output:"",approvals:[{approvalId:"a",digest:"a".repeat(64),provider:"fixture",kind:"tool",expiresAt:1000,action:{name,arguments:JSON.stringify(args),signature:"never expose host signature"}}]});
test("review binds exact replacement fragments and does not imply a full-file diff",()=>{
 const view=projectApprovalReview(run("apply_reviewed_replacement",{path:"a.ts",expectedDigest:"sha256:"+"b".repeat(64),oldText:"before\n",newText:"<img onerror=alert(1)>\n"}),s=>s);
 expect(view).toMatchObject({runId:"run_fixture",revision:7,items:[{approvalId:"a",digest:"a".repeat(64),complete:true,files:[{path:"a.ts",before:"before\n",after:"<img onerror=alert(1)>\n",view:"literal-replacement"}]}]});
 expect(JSON.stringify(view)).not.toContain("never expose");
 const changed=projectApprovalReview(run("apply_reviewed_replacement",{path:"a.ts",expectedDigest:"sha256:"+"b".repeat(64),oldText:"before\n",newText:"changed\n"}),s=>s);
 expect(changed.items[0]!.payloadDigest).not.toBe(view.items[0]!.payloadDigest);
});
test("redacted or unreviewable payloads cannot claim complete review",()=>{
 const view=projectApprovalReview(run("run_check",{check:"test",expectedScript:"echo secret-value"}),s=>s.replaceAll("secret-value","[REDACTED]"));
 expect(view.items[0]).toMatchObject({complete:false,restriction:"REDACTED",commands:["echo [REDACTED]"]});expect(JSON.stringify(view)).not.toContain("secret-value");
 expect(projectApprovalReview(run("unknown",{data:"x".repeat(300000)}),s=>s).items[0]).toMatchObject({complete:false,restriction:"TOO_LARGE"});
 const invalid=run("unknown",{});(invalid.approvals[0]!.action as {arguments:string}).arguments="invalid";
 expect(projectApprovalReview(invalid,s=>s).items[0]).toMatchObject({complete:false,restriction:"INVALID_PAYLOAD"});
});
test("commands preserve argv grouping and full-file replacement is labeled accurately",()=>{
 const command=projectApprovalReview(run("run_environment_command",{command:"node",args:["-e","console.log('a b')"]}),s=>s);
 expect(command.items[0]!.commands).toEqual([JSON.stringify(["node","-e","console.log('a b')"])]);
 const edit=projectApprovalReview(run("apply_reviewed_edits",{changes:[{path:"new.ts",expectedDigest:null,content:"new"}]}),s=>s);
 expect(edit.items[0]!.files[0]).toEqual({path:"new.ts",expectedDigest:null,after:"new",view:"replacement-contents"});
});
