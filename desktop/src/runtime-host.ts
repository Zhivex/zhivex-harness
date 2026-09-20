import { utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "../../src/local-service.js";
import { harnessClientRequestSchema } from "../../src/client-contract.js";
import type { DesktopContext, DesktopProject } from "./bridge.js";
export async function launchProjectRuntime(project:DesktopProject,options:{buildDirectory:string;directory:string;fixture:boolean;recover:boolean}){
 const worker=utilityProcess.fork(path.join(options.buildDirectory,"runtime.cjs"),[JSON.stringify({workspace:project.workspace,directory:options.directory,fixture:options.fixture,recover:options.recover})],{serviceName:`Harness · ${project.name}`,stdio:"pipe"});
 if(options.fixture)worker.stderr?.on("data",chunk=>process.stderr.write(chunk));
 let exited=false;const stopped=new Promise<void>(resolve=>worker.once("exit",()=>{exited=true;resolve();}));
 try{
  const ready=await new Promise<{credentialsPath:string;pid:number;node:string;stateDirectory:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error("RUNTIME_START_TIMEOUT")),15000);
   worker.once("message",message=>{clearTimeout(timer);if(message?.kind==="ready")resolve(message);else reject(new Error("RUNTIME_START_FAILED"));});
   worker.once("exit",()=>{clearTimeout(timer);reject(new Error("RUNTIME_EXITED"));});
  });
  const credentials=await readHarnessLocalCredentials(ready.credentialsPath);
  const hello=await requestHarnessLocalService(credentials,"hello",{versions:[1]});if(!hello.ok)throw new Error("PROTOCOL_UNSUPPORTED");
  const context:DesktopContext={project,projectId:hello.projectId,runtimePid:ready.pid,runtimeNode:ready.node,fixture:options.fixture};
  return {context,stateDirectory:ready.stateDirectory,isAlive:()=>!exited,
   async command(command:unknown){
    if(!command||typeof command!=="object"||Array.isArray(command)||"projectId" in command)throw new Error("INVALID_COMMAND");
    const parsed=harnessClientRequestSchema.safeParse({protocolVersion:1,requestId:`desktop_${randomUUID()}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
    if(!parsed.success)throw new Error("INVALID_COMMAND");
    return requestHarnessLocalService(credentials,"command",parsed.data);
   },
   async events(payload:unknown){
    const parsed=z.object({sessionId:z.string().min(1).max(160),after:z.number().int().nonnegative()}).strict().safeParse(payload);
    if(!parsed.success)throw new Error("INVALID_CURSOR");
    return requestHarnessLocalService(credentials,"events",{projectId:hello.projectId,...parsed.data});
   },
   async close(){if(!exited){worker.postMessage("close");await stopped;}}
  };
 }catch(error){if(!exited)worker.kill();await stopped;throw error;}
}
export type ProjectRuntime=Awaited<ReturnType<typeof launchProjectRuntime>>;
