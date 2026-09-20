import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../src/harness.js";
import { createHarnessClientAdapter, type HarnessClientCommand, type HarnessClientResponse, type HarnessClientData, type HarnessClientAdapterOptions } from "../src/client-contract.js";

const fixture = async (options?: HarnessClientAdapterOptions) => {
  const workspace = await mkdtemp(tmpdir()+"/har-client-");
  await writeFile(workspace+"/a.txt", "before\n");
  const model = createMockLanguageModel({ streamEvents: [[
    { type: "tool-call", toolCall: { id: "edit-1", name: "apply_reviewed_replacement", input: {
      path: "a.txt", expectedDigest: "sha256:"+createHash("sha256").update("before\n").digest("hex"), oldText: "before", newText: "after"
    } } }, { type: "finish", finishReason: "tool-calls" }
  ], [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }], [{ type: "text-delta", textDelta: "summary" }, { type: "finish", finishReason: "stop" }]] });
  const harness = await createHarness({ workspace, provider: "openai", modelInstance: model, subagentProfiles: [] });
  const adapter = await createHarnessClientAdapter(harness, options);
  const hello = adapter.negotiate([2,1]); if (!hello.ok) throw new Error("negotiation failed");
  let seq=0;
  const request = (command: Omit<HarnessClientCommand,"projectId"> & Record<string,unknown>) => ({protocolVersion:1,requestId:`req_${++seq}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
  const call = (command: Omit<HarnessClientCommand,"projectId"> & Record<string,unknown>) => adapter.dispatch(request(command));
  const close = async () => { adapter.close(); await harness.close(); await rm(workspace,{recursive:true,force:true}); };
  return { workspace, harness, adapter, hello, request, call, close };
};
const data = <K extends HarnessClientData["kind"]>(r: HarnessClientResponse, kind:K): Extract<HarnessClientData,{kind:K}> => {
  if (!r.ok) throw new Error(r.error.code);
  if(r.data.kind!==kind)throw new Error("wrong response kind");
  return r.data as Extract<HarnessClientData,{kind:K}>;
};
const start = async(f:Awaited<ReturnType<typeof fixture>>) => {
  const s=data(await f.call({method:"session.create",idempotencyKey:"create",title:"Test"}),"session").session;
  return data(await f.call({method:"run.start",idempotencyKey:"start",sessionId:s.sessionId,expectedRevision:s.revision,prompt:"Edit a.txt"}),"run");
};

describe("client protocol against the real harness, no terminal",()=>{
  test("project, session, edit approval, completion, query, continuation and replay",async()=>{
    const f=await fixture();try{
      expect(data(await f.call({method:"project.get"}),"project").projectId).toBe(f.hello.projectId);
      const pending=await start(f); expect(pending.run.status).toBe("waiting_approval");
      expect(await readFile(f.workspace+"/a.txt","utf8")).toBe("before\n");
      const command={method:"approval.resolve" as const,idempotencyKey:"approve",sessionId:pending.session.sessionId,runId:pending.run.runId,expectedRevision:pending.run.revision,decisions:pending.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
      const done=data(await f.call(command),"run"); expect(done.run.status).toBe("completed");
      expect(await readFile(f.workspace+"/a.txt","utf8")).toBe("after\n");
      const replay=data(await f.call(command),"run");expect(replay).toEqual(done);
      expect(f.harness.workspace.mutationAudit().length).toBe(1);
      const renamed=data(await f.call({method:"session.rename",sessionId:done.session.sessionId,expectedRevision:done.session.revision,idempotencyKey:"rename",title:"Renamed"}),"session");
      expect(data(await f.call({method:"session.list",search:"Renamed"}),"sessions").sessions).toHaveLength(1);
      const next=data(await f.call({method:"run.start",sessionId:renamed.session.sessionId,expectedRevision:renamed.session.revision,idempotencyKey:"next",prompt:"Summarize"}),"run");
      expect(next.session.runs).toHaveLength(2); expect(next.run.runId).not.toBe(done.run.runId);
      expect(data(await f.call({method:"run.get",sessionId:done.session.sessionId,runId:done.run.runId}),"run").run.status).toBe("completed");
    }finally{await f.close();}
  });
  test("stale revision and altered approval digest execute no effect",async()=>{
    const f=await fixture();try{
      const p=await start(f);const cmd={method:"approval.resolve" as const,sessionId:p.session.sessionId,runId:p.run.runId,expectedRevision:p.run.revision,decisions:p.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
      expect(await f.call({...cmd,idempotencyKey:"stale",expectedRevision:p.run.revision+1})).toMatchObject({ok:false,error:{code:"REVISION_CONFLICT"}});
      expect(await f.call({...cmd,idempotencyKey:"wrong",decisions:cmd.decisions.map(d=>({...d,digest:"0".repeat(64)}))})).toMatchObject({ok:false,error:{code:"APPROVAL_MISMATCH"}});
      expect(await readFile(f.workspace+"/a.txt","utf8")).toBe("before\n");
      await writeFile(f.workspace+"/a.txt","changed externally\n");
      expect(await f.call({...cmd,idempotencyKey:"drift"})).toMatchObject({ok:false,error:{code:"EXECUTION_FAILED"}});
      expect(await readFile(f.workspace+"/a.txt","utf8")).toBe("changed externally\n");
    }finally{await f.close();}
  });
  test("deny and checkpoint cancel preserve the file; cancellation is replayable",async()=>{
    for(const cancel of [true,false]){
      const f=await fixture();try{
        const p=await start(f);
        const command=cancel?{method:"run.cancel" as const,sessionId:p.session.sessionId,runId:p.run.runId,expectedRevision:p.run.revision,idempotencyKey:"decision"}:{method:"approval.resolve" as const,sessionId:p.session.sessionId,runId:p.run.runId,expectedRevision:p.run.revision,idempotencyKey:"decision",decisions:p.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:false}))};
        const result=await f.call(command);expect(result.ok).toBe(cancel);
        if(!cancel)expect(result).toMatchObject({error:{code:"EXECUTION_FAILED"}});
        if(cancel)expect(data(result,"run").run.status).toBe("cancelled");
        expect(await f.call(command)).toMatchObject({...result,requestId:expect.any(String)});
        expect(await readFile(f.workspace+"/a.txt","utf8")).toBe("before\n");
      }finally{await f.close();}
    }
  });
  test("concurrent duplicate creates once, mismatch fails, returned data cannot alter receipt",async()=>{
    const f=await fixture();try{
      const cmd={method:"session.create" as const,idempotencyKey:"same",title:"one"};
      const [a,b]=await Promise.all([f.call(cmd),f.call(cmd)]);expect(data(a,"session")).toEqual(data(b,"session"));
      data(a,"session").session.title="tampered";
      expect(data(await f.call(cmd),"session").session.title).toBe("one");
      expect(await f.call({...cmd,title:"two"})).toMatchObject({ok:false,error:{code:"IDEMPOTENCY_CONFLICT"}});
      expect(data(await f.call({method:"session.list"}),"sessions").sessions).toHaveLength(1);
    }finally{await f.close();}
  });
  test("restart requires a new connection, recovers durable session and pending approval",async()=>{
    const f=await fixture();try{
      const p=await start(f);const old=f.request({method:"session.get",sessionId:p.session.sessionId});
      f.adapter.close();const second=await createHarnessClientAdapter(f.harness);
      try{
        expect(await second.dispatch(old)).toMatchObject({ok:false,error:{code:"CONNECTION_EXPIRED"}});
        const hello=second.negotiate([1]);if(!hello.ok)throw new Error("hello");
        const r=data(await second.dispatch({...old,connectionId:hello.connectionId,command:{method:"run.get",projectId:hello.projectId,sessionId:p.session.sessionId,runId:p.run.runId}}),"run");
        expect(r.run.approvals).toEqual(p.run.approvals);
      }finally{second.close();}
    }finally{await f.close();}
  });
  test("unnegotiated protocol, unknown fields and cross-project/run identifiers fail closed",async()=>{
    const f=await fixture();try{
      expect(f.adapter.negotiate([99])).toMatchObject({ok:false,error:{code:"VERSION_UNSUPPORTED"}});
      const req=f.request({method:"session.create",idempotencyKey:"test"});
      expect(await f.adapter.dispatch({...req,command:{...req.command,workspace:"/tmp"}})).toMatchObject({ok:false,error:{code:"INVALID_REQUEST"}});
      expect(await f.adapter.dispatch({...req,command:{...req.command,projectId:"other"}})).toMatchObject({ok:false,error:{code:"NOT_FOUND"}});
      const p=await start(f);const other=data(await f.call({method:"session.create",idempotencyKey:"other"}),"session").session;
      expect(await f.call({method:"run.get",sessionId:other.sessionId,runId:p.run.runId})).toMatchObject({ok:false,error:{code:"NOT_FOUND"}});
      expect(await f.call({method:"session.rename",sessionId:p.session.sessionId,expectedRevision:0,idempotencyKey:"badrev",title:"wrong"})).toMatchObject({ok:false,error:{code:"REVISION_CONFLICT"}});
    }finally{await f.close();}
  });
});

test("two clients decide once and a persisted approval expiry rejects late decisions",async()=>{
 const f=await fixture();try{
  const p=await start(f);const command={method:"approval.resolve" as const,sessionId:p.session.sessionId,runId:p.run.runId,expectedRevision:p.run.revision,decisions:p.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
  const [first,second]=await Promise.all([f.call({...command,idempotencyKey:"client-one"}),f.call({...command,idempotencyKey:"client-two"})]);
  expect(first.ok).toBe(true);expect(second).toMatchObject({ok:false,error:{code:"REVISION_CONFLICT"}});expect(f.harness.workspace.mutationAudit()).toHaveLength(1);
 }finally{await f.close();}
 const late=await fixture({now:()=>Date.now()+60*60*1000});try{
  const p=await start(late);expect(p.run.approvals[0]!.expiresAt).toBeLessThan(Date.now()+60*60*1000);
  expect(await late.call({method:"approval.resolve",sessionId:p.session.sessionId,runId:p.run.runId,expectedRevision:p.run.revision,idempotencyKey:"expired",decisions:p.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))})).toMatchObject({ok:false,error:{code:"APPROVAL_MISMATCH"}});
  expect(await readFile(late.workspace+"/a.txt","utf8")).toBe("before\n");
 }finally{await late.close();}
});
