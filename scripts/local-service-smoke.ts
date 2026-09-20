/** Node subprocess crash/reconnect demonstration; accepts an installed dist/index.js. */
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm,readFile } from "node:fs/promises";
import { spawn,type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { HarnessClientCommand,HarnessClientNegotiation } from "../src/client-contract.js";
const entry=path.resolve(process.argv[2]??"dist/index.js");const api:typeof import("../src/index.js")=await import(pathToFileURL(entry).href);
const testing=import.meta.resolve("@zhivex-ai/agents/testing");
const root=await mkdtemp("/tmp/har-process-smoke-");const workspace=root+"/repo";
await (await import("node:fs/promises")).mkdir(workspace);await writeFile(workspace+"/a.txt","before\n");
const fixture=root+"/runtime.mjs";
await writeFile(fixture,`import{createHash}from'node:crypto';
import{createHarness,startHarnessLocalService}from${JSON.stringify(pathToFileURL(entry).href)};
import{createMockLanguageModel}from${JSON.stringify(testing)};
const c=JSON.parse(process.argv[2]);
const edit=[{type:'tool-call',toolCall:{id:'edit-1',name:'apply_reviewed_replacement',input:{path:'a.txt',expectedDigest:'sha256:'+createHash('sha256').update('before\\n').digest('hex'),oldText:'before',newText:'after'}}},{type:'finish',finishReason:'tool-calls'}];
const done=[{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}];
const model=createMockLanguageModel({streamEvents:c.resume?[done]:[edit,done]});
const h=await createHarness({workspace:c.workspace,provider:'openai',modelInstance:model,subagentProfiles:[]});
const service=await startHarnessLocalService(h,{directory:c.directory});
process.stdout.write(JSON.stringify({credentialsPath:service.credentialsPath})+'\\n');
process.once('SIGTERM',()=>{void service.close();});
`);
const cli=async(args:string[])=>{
 const child=spawn("node",[path.join(path.dirname(entry),"cli.js"),...args],{env:{PATH:process.env.PATH!,HOME:root},stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",c=>stdout+=c);child.stderr.on("data",c=>stderr+=c);
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
 assert.equal(code,0,stderr);return stdout;
};
let current:ChildProcess|undefined;
const boot=async(resume=false)=>{
 const child=spawn("node",[fixture,JSON.stringify({workspace,directory:root+"/socket",resume})],{env:{PATH:process.env.PATH!,HOME:root},stdio:["ignore","pipe","pipe"]});current=child;
 const stopped=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
 const ready=await new Promise<{credentialsPath:string}>((resolve,reject)=>{
  let text="";const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("SERVICE_BOOT_TIMEOUT"));},10000);
  child.stdout!.on("data",chunk=>{text+=chunk.toString();if(text.includes("\n")){clearTimeout(timer);try{resolve(JSON.parse(text.split("\n")[0]!));}catch{reject(new Error("SERVICE_READY_INVALID"));}}});
  child.once("exit",()=>{clearTimeout(timer);reject(new Error("SERVICE_EXITED_BEFORE_READY"));});child.once("error",()=>{clearTimeout(timer);reject(new Error("SERVICE_SPAWN_FAILED"));});
 });
 const credentials=await api.readHarnessLocalCredentials(ready.credentialsPath);
 const hello=await api.requestHarnessLocalService(credentials,"hello",{versions:[1]});assert(hello.ok);
 let sequence=0;
 const call=(command:Omit<HarnessClientCommand,"projectId">&Record<string,unknown>)=>api.requestHarnessLocalService(credentials,"command",{protocolVersion:1,requestId:`request_${++sequence}`,connectionId:hello.connectionId,command:{projectId:hello.projectId,...command}});
 return{child,stopped,credentials,hello,call};
};
try{
 const first=await boot();const s=await first.call({method:"session.create",idempotencyKey:"create"});assert(s.ok&&s.data.kind==="session");const sessionId=s.data.session.sessionId;
 const cliStarted=JSON.parse(await cli(["run","--service",first.credentials.socketPath.replace(/\.sock$/,".json"),"--session",sessionId,"--json","Edit a.txt"]));
 api.parseCliJsonDocument(cliStarted);assert.equal(cliStarted.status,"waiting_approval");
 const pending=await first.call({method:"run.get",sessionId,runId:cliStarted.runId});assert(pending.ok&&pending.data.kind==="run");assert.equal(pending.data.run.status,"waiting_approval");
 const runId=pending.data.run.runId;const page=await api.requestHarnessLocalService(first.credentials,"events",{projectId:first.hello.projectId,sessionId});
 first.child.kill("SIGKILL");await first.stopped;
 const {createMockLanguageModel}=await import(testing);
 const repair=await api.createHarness({workspace,provider:"openai",modelInstance:createMockLanguageModel(),subagentProfiles:[]});
 try{await api.recoverHarnessLocalService(repair,root+"/socket");}finally{await repair.close();}
 const second=await boot(true);
 const state=await second.call({method:"run.get",sessionId,runId});assert(state.ok&&state.data.kind==="run");assert.deepEqual(state.data.run.approvals,pending.data.run.approvals);
 const replay=await api.requestHarnessLocalService(second.credentials,"events",{projectId:second.hello.projectId,sessionId});assert.deepEqual(replay,page);
 await assert.rejects(api.requestHarnessLocalService(first.credentials,"hello",{versions:[1]}));
 const command={method:"approval.resolve" as const,sessionId,runId,expectedRevision:state.data.run.revision,idempotencyKey:"approve",decisions:state.data.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
 const resumed=await cli(["resume",runId,"--service",second.credentials.socketPath.replace(/\.sock$/,".json"),"--session",sessionId,"--approve","--jsonl"]);
 const lines=resumed.trim().split("\n").map(line=>api.parseCliJsonLineDocument(JSON.parse(line)));
 assert.equal(lines.at(-1)?.kind,"run-stream-result");
 const done=await second.call({method:"run.get",sessionId,runId});assert(done.ok&&done.data.kind==="run");assert.equal(done.data.run.status,"completed");
 const duplicate=await second.call(command);assert.equal(duplicate.ok,false);
 const sessions=JSON.parse(await cli(["sessions","list","--service",second.credentials.socketPath.replace(/\.sock$/,".json"),"--json"]));api.parseCliJsonDocument(sessions);assert.equal(sessions.sessions.length,1);
 assert.equal(await readFile(workspace+"/a.txt","utf8"),"after\n");
 second.child.kill("SIGTERM");await second.stopped;
 const audit=await api.createHarness({workspace,provider:"openai",modelInstance:createMockLanguageModel(),subagentProfiles:[]});
 try{const journal=await audit.store.listToolCalls?.(runId,audit.config.scope);assert.equal(journal?.filter(j=>j.toolName==="apply_reviewed_replacement").length,1);assert.equal(journal?.find(j=>j.toolName==="apply_reviewed_replacement")?.status,"completed");}finally{await audit.close();}
 console.log("Node service smoke passed: crash at approval, explicit dead-owner recovery, rotated credentials, replay and single edit.");
}finally{if(current&&current.exitCode===null&&current.signalCode===null){current.kill("SIGKILL");await new Promise(resolve=>current!.once("exit",resolve));}await rm(root,{recursive:true,force:true});}
