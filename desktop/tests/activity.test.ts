import {test,expect} from "bun:test";
import {applyActivityPage,emptyActivity} from "../src/activity.js";
import {desktopRedactor} from "../src/redaction.js";
import type {HarnessClientResponse} from "../../src/client-contract.js";

test("replayed and overlapping pages do not duplicate text or regress the cursor",()=>{
 const events=[{schemaVersion:1 as const,eventId:"one",sequence:1,sessionId:"s",runId:"r",at:0,activity:{type:"text-delta",textDelta:"one "}},{schemaVersion:1 as const,eventId:"two",sequence:2,sessionId:"s",runId:"r",at:0,activity:{type:"text-delta",textDelta:"two "}}];
 const first=applyActivityPage(emptyActivity(),{schemaVersion:1,cursorExpired:false,nextCursor:1,events:[events[0]!]});
 const all=applyActivityPage(first,{schemaVersion:1,cursorExpired:false,nextCursor:2,events});
 expect(all.runs.r?.text).toBe("one two ");expect(applyActivityPage(all,{schemaVersion:1,cursorExpired:false,nextCursor:2,events})).toEqual(all);
 expect(applyActivityPage(all,{schemaVersion:1,cursorExpired:false,nextCursor:1,events:[events[0]!]})).toEqual(all);
 const recovered=applyActivityPage(all,{schemaVersion:1,cursorExpired:true,nextCursor:8,events:[],snapshot:{schemaVersion:1,sessionId:"s",sequence:8,runs:{r:{text:"snapshot",prompt:"question",status:"completed",truncated:false,tools:{c:{name:"run_check",status:"failed",exitCode:7}}}}}});
 expect(recovered.runs.r?.text).toBe("snapshot");expect(recovered.recovered).toBe(true);expect(recovered.runs.r?.tools?.c?.exitCode).toBe(7);
});

test("renderer boundary drops rich CLI and approval payloads and redacts known credentials",()=>{
 const secret="private-fixture-credential-28",redact=desktopRedactor([secret]);
 const raw={protocolVersion:1,requestId:"test",ok:true,data:{kind:"run",session:{title:secret},run:{runId:"r",revision:1,status:"waiting_approval",output:secret,cliResult:{output:secret,metadata:{private:secret}},approvals:[{approvalId:"a",digest:"a".repeat(64),expiresAt:0,provider:"mock",kind:"tool",action:{name:"read_file",arguments:{key:secret},signature:secret}}]}}} as unknown as HarnessClientResponse;
 const result=redact.response(raw);expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain("cliResult");expect(JSON.stringify(result)).not.toContain("signature");expect(JSON.stringify(result)).not.toContain("arguments");
 expect(JSON.stringify(raw)).toContain(secret);expect(redact.text("sk-secret-token <script>bad()</script>")).toBe("[REDACTED] <script>bad()</script>");
});
