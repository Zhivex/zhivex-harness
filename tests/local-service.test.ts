import { test, expect } from "bun:test";
import { request } from "node:http";
import { mkdtemp, mkdir, lstat, rm, readFile, writeFile } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { LanguageModel } from "@zhivex-ai/agents";
import { createHarness } from "../src/harness.js";
import { startHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService } from "../src/local-service.js";

const setup = async (modelInstance?: LanguageModel) => {
  const root = await mkdtemp("/tmp/har-service-"); const workspace=root+"/repo"; await mkdir(workspace);
  const harness=await createHarness({workspace,provider:"openai",modelInstance:modelInstance??createMockLanguageModel({streamEvents:[[{type:"text-delta",textDelta:"hello"},{type:"finish",finishReason:"stop"}]]}),subagentProfiles:[]});
  const service=await startHarnessLocalService(harness,{directory:root+"/socket"});
  const credentials=await readHarnessLocalCredentials(service.credentialsPath);
  const hello=await requestHarnessLocalService(credentials,"hello",{versions:[1]});
  if(!hello.ok || !("connectionId" in hello))throw new Error("hello");
  let next=0;
  const call=(command:Record<string,unknown>)=>requestHarnessLocalService(credentials,"command",{protocolVersion:1,connectionId:hello.connectionId,requestId:`req_${++next}`,command:{projectId:hello.projectId,...command}});
  return {root,harness,service,credentials,hello,call,close:async()=>{await service.close();await rm(root,{recursive:true,force:true});}};
};
const raw=(socketPath:string,headers:Record<string,string>={},method="GET",url="/health",body="")=>new Promise<number>((resolve,reject)=>{
  const req=request({socketPath,path:url,method,headers},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});req.on("error",reject);req.end(body);
});
test("private service authenticates, negotiates and dispatches the real runtime",async()=>{
 const f=await setup();try{
  expect((await lstat(f.service.socketPath)).mode&0o777).toBe(0o600);
  expect((await lstat(f.service.credentialsPath)).mode&0o777).toBe(0o600);
  expect(await raw(f.service.socketPath)).toBe(401);
  expect(await raw(f.service.socketPath,{authorization:`Bearer ${f.credentials.token}`,origin:"http://evil.invalid"})).toBe(403);
  expect(await raw(f.service.socketPath,{authorization:`Bearer ${f.credentials.token}`})).toBe(200);
  const s=await f.call({method:"session.create",idempotencyKey:"create",title:"transport"});
  if(!s.ok || !("data"in s) || s.data.kind!=="session")throw new Error("session");
  const result=await f.call({method:"run.start",idempotencyKey:"start",sessionId:s.data.session.sessionId,expectedRevision:s.data.session.revision,prompt:"hello"});
  expect(result).toMatchObject({ok:true,data:{kind:"run",run:{status:"completed",output:"hello"}}});
  const listed=await f.call({method:"session.list"});expect(listed).toMatchObject({ok:true,data:{kind:"sessions",sessions:[{runs:[{status:"completed"}]}]}});
  expect(await f.call({method:"project.get",workspace:"/"})).toMatchObject({ok:false,error:{code:"INVALID_REQUEST"}});
 }finally{await f.close();}
});
test("shutdown removes only owned transport files and preserves durable sessions",async()=>{
 const f=await setup();try{
  await f.call({method:"session.create",idempotencyKey:"create",title:"persist"});
  await expect(startHarnessLocalService(f.harness,{directory:f.root+"/socket"})).rejects.toThrow();
  await f.service.close();await f.service.close();
  await expect(lstat(f.service.socketPath)).rejects.toThrow();
  expect((await lstat(f.harness.config.stateDirectory+"/operations.sqlite")).isFile()).toBe(true);
  const secondHarness=await createHarness({workspace:f.root+"/repo",provider:"openai",modelInstance:createMockLanguageModel(),subagentProfiles:[]});
  const second=await startHarnessLocalService(secondHarness,{directory:f.root+"/socket"});
  try{
   const creds=await readHarnessLocalCredentials(second.credentialsPath);expect(creds.token).not.toBe(f.credentials.token);
   await expect(requestHarnessLocalService(f.credentials,"hello",{versions:[1]})).rejects.toThrow("HTTP_401");
   const h=await requestHarnessLocalService(creds,"hello",{versions:[1]});if(!h.ok||!("connectionId"in h))throw new Error("hello");
   const result=await requestHarnessLocalService(creds,"command",{protocolVersion:1,connectionId:h.connectionId,requestId:"list",command:{method:"session.list",projectId:h.projectId}});
   expect(result).toMatchObject({ok:true,data:{sessions:[{title:"persist"}]}});
  }finally{await second.close();}
 }finally{await f.close();}
});
test("unsafe credential modes and stale socket paths fail closed",async()=>{
 const root=await mkdtemp("/tmp/har-unsafe-");try{
  const file=root+"/credentials.json";await writeFile(file,JSON.stringify({schemaVersion:1,socketPath:"/tmp/test.sock",token:"a".repeat(64)}),{mode:0o644});
  await expect(readHarnessLocalCredentials(file)).rejects.toThrow("UNSAFE");
  const harness=await createHarness({workspace:root,provider:"openai",modelInstance:createMockLanguageModel()});
  try{await mkdir(root+"/public",{mode:0o755});await expect(startHarnessLocalService(harness,{directory:root+"/public"})).rejects.toThrow("UNSAFE");}finally{await harness.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});

test("disconnect during streaming retains activity and drains accepted work on shutdown",async()=>{
 let begin!:()=>void,release!:()=>void;const began=new Promise<void>(r=>begin=r),gate=new Promise<void>(r=>release=r);
 const mock=createMockLanguageModel();const model:LanguageModel={...mock,async stream(){return(async function*(){yield {type:"text-delta" as const,textDelta:"before disconnect "};begin();await gate;yield{type:"text-delta" as const,textDelta:"after reconnect"};yield{type:"finish" as const,finishReason:"stop" as const};})();}};
 const f=await setup(model);try{
  const s=await f.call({method:"session.create",idempotencyKey:"create"});if(!s.ok||s.data.kind!=="session")throw new Error("session");
  const sessionId=s.data.session.sessionId;
  const body=JSON.stringify({protocolVersion:1,requestId:"disconnected",connectionId:f.hello.connectionId,command:{method:"run.start",projectId:f.hello.projectId,sessionId,expectedRevision:s.data.session.revision,idempotencyKey:"start",prompt:"stream"}});
  const req=request({socketPath:f.credentials.socketPath,path:"/command",method:"POST",headers:{authorization:`Bearer ${f.credentials.token}`,"content-type":"application/json"}},res=>res.resume());req.on("error",()=>{});req.end(body);
  await began;req.destroy();
  const page=await requestHarnessLocalService(f.credentials,"events",{projectId:f.hello.projectId,sessionId});expect(page.events.length).toBeGreaterThan(0);
  const firstCursor=page.nextCursor;release();
  await f.service.close();
  const {openHarnessActivityStore}=await import("../src/service-events.js");const activity=await openHarnessActivityStore(f.harness.config);
  try{const missing=activity.replay(sessionId,firstCursor);expect(missing.events.some(e=>e.activity.status==="completed")).toBe(true);expect(missing.events.map(e=>e.activity.textDelta??"").join("")).toContain("after reconnect");}finally{activity.close();}
 }finally{release();await f.close();}
});

test("another client cancels an active run using its durable revision",async()=>{
 let begin!:()=>void;const began=new Promise<void>(r=>begin=r);
 const mock=createMockLanguageModel();const model:LanguageModel={...mock,async stream(input){return(async function*(){yield {type:"text-delta" as const,textDelta:"working "};begin();await new Promise<void>(resolve=>{if(input.abortSignal?.aborted)resolve();else input.abortSignal?.addEventListener("abort",()=>resolve(),{once:true});});yield{type:"finish" as const,finishReason:"stop" as const};})();}};
 const f=await setup(model);try{
  const s=await f.call({method:"session.create",idempotencyKey:"create"});if(!s.ok||s.data.kind!=="session")throw new Error("session");
  const sessionId=s.data.session.sessionId;const pending=f.call({method:"run.start",idempotencyKey:"start",sessionId,expectedRevision:s.data.session.revision,prompt:"work"});await began;
  const page=await requestHarnessLocalService(f.credentials,"events",{projectId:f.hello.projectId,sessionId});const runId=page.events[0]!.runId;
  const state=await f.call({method:"run.get",sessionId,runId});if(!state.ok||state.data.kind!=="run")throw new Error("run");
  const cancel=await f.call({method:"run.cancel",idempotencyKey:"cancel",sessionId,runId,expectedRevision:state.data.run.revision});expect(cancel.ok).toBe(true);
  await pending;
  const result=await f.call({method:"run.get",sessionId,runId});expect(result).toMatchObject({ok:true,data:{run:{status:"cancelled"}}});
 }finally{await f.close();}
},10000);
