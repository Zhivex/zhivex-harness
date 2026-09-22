import {test,expect} from "bun:test";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {resolveHarnessConfig} from "../src/config.js";
import {openHarnessActivityStore} from "../src/service-events.js";

test("cursor replay is durable and duplicate delivery has stable identities",async()=>{
 const root=await mkdtemp("/tmp/har-events-");const config=resolveHarnessConfig({workspace:root});
 try{
  let store=await openHarnessActivityStore(config);
  store.append("s1","r1",{type:"text-delta",textDelta:"hello world"});store.checkpoint("s1","r1","waiting_approval");
  const first=store.replay("s1");expect(first.events.map(e=>e.activity.textDelta).filter(Boolean).join("")).toBe("hello world");
  expect(new Set(first.events.map(e=>e.eventId)).size).toBe(first.events.length);
  store.close();store=await openHarnessActivityStore(config);
  expect(store.replay("s1")).toEqual(first);
  expect(store.replay("s1",first.nextCursor).events).toHaveLength(0);
  store.checkpoint("s1","r1","completed");expect(store.replay("s1",first.nextCursor).events).toHaveLength(1);
  expect(store.replay("s2").events).toHaveLength(0);
  expect(()=>store.replay("s1",Number.MAX_SAFE_INTEGER)).toThrow("AHEAD");
  store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test("split secrets and raw tool/provider payloads never enter replay or snapshot",async()=>{
 const root=await mkdtemp("/tmp/har-events-secret-");const config=resolveHarnessConfig({workspace:root});
 try{
  const secret="sk-secret0123456789";const store=await openHarnessActivityStore(config,{sensitiveValues:[secret],maxEvents:2});
  store.append("s","r",{type:"text-delta",textDelta:"answer sk-sec"});store.append("s","r",{type:"text-delta",textDelta:"ret0123456789 done"});
  store.append("s","r",{type:"tool-call",toolCall:{id:"tool-1",name:"read_file",input:{contents:secret}}});
  store.checkpoint("s","r","completed");
  const replay=store.replay("s");expect(replay.cursorExpired).toBe(true);expect(replay.snapshot?.runs.r?.text).toBe("answer [REDACTED] done");
  expect(JSON.stringify(replay)).not.toContain(secret);expect(JSON.stringify(replay)).not.toContain("contents");
  store.close();expect((await readFile(config.stateDirectory+"/operations.sqlite")).includes(Buffer.from(secret))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("expired cursors get atomic snapshot and explicit recovery cursor; isolation and truncation",async()=>{
 const root=await mkdtemp("/tmp/har-events-limit-");const config=resolveHarnessConfig({workspace:root});let now=0;
 try{
  const store=await openHarnessActivityStore(config,{maxEvents:3,retentionMs:10,now:()=>now});
  store.append("s","r",{type:"text-delta",textDelta:"one "});store.append("s","r",{type:"text-delta",textDelta:"two "});
  now=20;const old=store.replay("s");expect(old.cursorExpired).toBe(true);expect(old.snapshot?.runs.r?.text).toBe("one two ");
  store.append("s","r",{type:"text-delta",textDelta:"three "});expect(store.replay("s",old.nextCursor).events).toHaveLength(1);
  store.append("s","r",{type:"text-delta",textDelta:"x".repeat(20000)});store.checkpoint("s","r","interrupted");
  const snapshot=store.replay("s").snapshot;expect(snapshot?.runs.r?.text).toContain("[TRUNCATED]");
  const other=await openHarnessActivityStore({...config,scope:{tenantId:"other"}});
  expect(other.replay("s").events).toHaveLength(0);other.close();store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test("expired snapshot preserves redacted prompts and actual failed check receipts",async()=>{
 const root=await mkdtemp("/tmp/har-events-check-");try{
  const store=await openHarnessActivityStore(resolveHarnessConfig({workspace:root}),{maxEvents:1,sensitiveValues:["fixture-private-28"]});
  store.prompt("s","r","Question fixture-private-28 <img onerror=alert(1)>");
  store.append("s","r",{type:"tool-call",toolCall:{id:"check",name:"run_check",input:{secret:"fixture-private-28"}}});
  store.append("s","r",{type:"tool-result",toolResult:{toolCallId:"check",toolName:"run_check",isError:false,output:{exitCode:7,timedOut:false,stdout:"fixture-private-28"}}});
  store.checkpoint("s","r","completed");const snapshot=store.replay("s");
  expect(snapshot.cursorExpired).toBe(true);expect(snapshot.snapshot?.runs.r?.prompt).toBe("Question [REDACTED] <img onerror=alert(1)>");
  expect(snapshot.snapshot?.runs.r?.tools?.["tool:check"]).toMatchObject({name:"run_check",status:"failed",exitCode:7,timedOut:false});
  expect(JSON.stringify(snapshot)).not.toContain("fixture-private-28");expect(JSON.stringify(snapshot)).not.toContain("stdout");store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test("known credentials containing whitespace remain private across stream boundaries",async()=>{
 const root=await mkdtemp("/tmp/har-events-spaced-");try{
  const store=await openHarnessActivityStore(resolveHarnessConfig({workspace:root}),{sensitiveValues:["private phrase value"]});
  store.append("s","r",{type:"text-delta",textDelta:"answer private phrase "});
  expect(JSON.stringify(store.replay("s"))).not.toContain("private phrase");
  store.append("s","r",{type:"text-delta",textDelta:"value next "});store.checkpoint("s","r","completed");
  expect(store.replay("s").events.map(e=>e.activity.textDelta??"").join("")).toBe("answer [REDACTED] next ");store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
