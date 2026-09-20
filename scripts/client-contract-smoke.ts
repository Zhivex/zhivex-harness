/** Offline reference client; optionally exercises a packed/installed entrypoint. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { HarnessClientCommand, HarnessClientRequest } from "../src/client-contract.js";
const api: typeof import("../src/index.js") = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "../src/index.js");
const workspace = await mkdtemp(tmpdir()+"/har-client-smoke-");
const hash = (s: string) => "sha256:"+createHash("sha256").update(s).digest("hex");
await writeFile(workspace+"/a.txt", "before\n");
const model = createMockLanguageModel({ streamEvents: [
  [{ type: "tool-call", toolCall: { id: "edit-1", name: "apply_reviewed_replacement", input: {path:"a.txt",expectedDigest:hash("before\n"),oldText:"before",newText:"after"} } }, {type:"finish",finishReason:"tool-calls"}],
  [{type:"text-delta",textDelta:"Edited"},{type:"finish",finishReason:"stop"}],
  [{ type: "tool-call", toolCall: { id: "edit-2", name: "apply_reviewed_replacement", input: {path:"a.txt",expectedDigest:hash("after\n"),oldText:"after",newText:"cancelled edit"} } }, {type:"finish",finishReason:"tool-calls"}]
] });
const harness = await api.createHarness({workspace,provider:"openai",modelInstance:model,subagentProfiles:[]});
const adapter = await api.createHarnessClientAdapter(harness);
try {
  const hello = adapter.negotiate([1]); assert(hello.ok);
  let sequence = 0;
  const call = async(command: HarnessClientCommand) => {
    const request: HarnessClientRequest = {protocolVersion:1,connectionId:hello.connectionId,requestId:`req_${++sequence}`,command};
    const response = await adapter.dispatch(JSON.parse(JSON.stringify(request)));
    assert(response.ok); return response.data;
  };
  const projectId = hello.projectId;
  assert.equal((await call({method:"project.get",projectId})).kind,"project");
  const created = await call({method:"session.create",projectId,idempotencyKey:"create",title:"Reference client"});assert(created.kind==="session");
  const renamed = await call({method:"session.rename",projectId,sessionId:created.session.sessionId,expectedRevision:created.session.revision,idempotencyKey:"rename",title:"Reference renamed"});assert(renamed.kind==="session");
  const start = await call({method:"run.start",projectId,sessionId:created.session.sessionId,expectedRevision:renamed.session.revision,idempotencyKey:"start",prompt:"Edit a.txt"});assert(start.kind==="run");assert.equal(start.run.status,"waiting_approval");
  const approve: HarnessClientCommand = {method:"approval.resolve",projectId,sessionId:start.session.sessionId,runId:start.run.runId,expectedRevision:start.run.revision,idempotencyKey:"approve",decisions:start.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
  const done = await call(approve);assert(done.kind==="run");assert.equal(done.run.status,"completed");
  assert.deepEqual(await call(approve),done);
  assert.equal(await readFile(workspace+"/a.txt","utf8"),"after\n");
  const next = await call({method:"run.start",projectId,sessionId:done.session.sessionId,expectedRevision:done.session.revision,idempotencyKey:"next",prompt:"Prepare another edit"});assert(next.kind==="run");
  const cancel: HarnessClientCommand = {method:"run.cancel",projectId,sessionId:next.session.sessionId,runId:next.run.runId,expectedRevision:next.run.revision,idempotencyKey:"cancel"};
  const cancelled = await call(cancel);assert(cancelled.kind==="run");assert.equal(cancelled.run.status,"cancelled");
  assert.deepEqual(await call(cancel),cancelled);
  assert.equal(await readFile(workspace+"/a.txt","utf8"),"after\n");
  console.log("Client protocol v1 smoke passed: project/session/edit/approval/replay/cancel; no provider calls.");
} finally { adapter.close(); await harness.close(); await rm(workspace,{recursive:true,force:true}); }
