import {expect,test} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHarness} from "../src/runtime/harness.js";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import {recoverHarnessLocalService} from "../src/client/local-service.js";
import {openCliSessionStore} from "../src/persistence/sessions.js";
test("concurrent dead-owner recovery serializes, preserves sessions and never removes a replacement live owner",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"har-recover-")),socket=path.join(root,"socket");await mkdir(socket,{mode:0o700});
 const harness=await createHarness({workspace:root,provider:"openai",modelInstance:createMockLanguageModel(),subagentProfiles:[]});
 const identity=createHash("sha256").update(JSON.stringify([harness.config.workspace,harness.config.scope])).digest("hex").slice(0,20),lock=path.join(socket,`${identity}.lock`),credentials=path.join(socket,`${identity}.json`);
 try{
  const sessions=await openCliSessionStore({workspace:harness.config.workspace,stateDirectory:harness.config.stateDirectory,scope:harness.config.scope});const session=await sessions.create({title:"durable"});sessions.close();
  const child=Bun.spawn([process.execPath,"-e","process.exit(0)"],{stdout:"ignore",stderr:"ignore"});await child.exited;
  expect(()=>process.kill(child.pid,0)).toThrow();
  await writeFile(lock,JSON.stringify({schemaVersion:1,pid:child.pid}),{mode:0o600});await writeFile(credentials,"stale credentials",{mode:0o600});
  const started=Date.now();
  const outcomes=await Promise.allSettled([recoverHarnessLocalService(harness,socket),recoverHarnessLocalService(harness,socket)]);
  expect(Date.now()-started).toBeLessThan(2000);
  expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  await expect(readFile(lock)).rejects.toThrow();await expect(readFile(credentials)).rejects.toThrow();
  await writeFile(lock,JSON.stringify({schemaVersion:1,pid:process.pid}),{mode:0o600});await writeFile(credentials,"replacement credentials",{mode:0o600});
  await expect(recoverHarnessLocalService(harness,socket)).rejects.toThrow("OWNER_ALIVE");expect(await readFile(credentials,"utf8")).toBe("replacement credentials");
  const restored=await openCliSessionStore({workspace:harness.config.workspace,stateDirectory:harness.config.stateDirectory,scope:harness.config.scope});try{expect((await restored.get(session.sessionId))?.title).toBe("durable");}finally{restored.close();}
 }finally{await harness.close();await rm(root,{recursive:true,force:true});}
});
