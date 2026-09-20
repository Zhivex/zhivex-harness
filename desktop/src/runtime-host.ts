import { utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "../../src/local-service.js";
import { ReviewTickets } from "./review-tickets.js";
import { projectApprovalReview } from "./approval-review.js";
import { desktopRedactor,hostSensitiveValues } from "./redaction.js";
import { harnessClientRequestSchema } from "../../src/client-contract.js";
import type { DesktopContext, DesktopProject } from "./bridge.js";
export async function launchProjectRuntime(project:DesktopProject,options:{buildDirectory:string;directory:string;fixture:boolean;fixtureOci?:boolean;fixtureEffectCrash?:boolean;recover:boolean}){
 const worker=utilityProcess.fork(path.join(options.buildDirectory,"runtime.cjs"),[JSON.stringify({workspace:project.workspace,directory:options.directory,fixture:options.fixture,fixtureOci:options.fixture&&options.fixtureOci===true,fixtureEffectCrash:options.fixture&&options.fixtureEffectCrash===true,recover:options.recover})],{serviceName:`Harness · ${project.name}`,stdio:"pipe"});
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
  const redact=desktopRedactor([...hostSensitiveValues(process.env),credentials.token]);
  const context:DesktopContext={project,projectId:hello.projectId,runtimePid:ready.pid,runtimeNode:ready.node,fixture:options.fixture};
  const tickets=new ReviewTickets();
  let fixtureOffline=false,fixtureDropResponse=false;
  return {async crashFixture(){if(!options.fixture)throw new Error("FIXTURE_DISABLED");if(!exited)worker.kill();await stopped;},async setFixtureApprovalClock(offset:number){
    if(!options.fixture)throw new Error("FIXTURE_DISABLED");
    const requestId=randomUUID();await new Promise<void>((resolve,reject)=>{
      const listener=(message:{kind?:string;requestId?:string})=>{if(message.kind==="fixture-clock-ack"&&message.requestId===requestId){clearTimeout(timer);worker.off("message",listener);resolve();}};
      const timer=setTimeout(()=>{worker.off("message",listener);reject(new Error("FIXTURE_CLOCK_TIMEOUT"));},2000);
      worker.on("message",listener);worker.postMessage({kind:"fixture-clock",offset,requestId});
    });
   },fixtureCredentialsPath(){if(!options.fixture)throw new Error("FIXTURE_DISABLED");return ready.credentialsPath;},dropFixtureRunResponse(){if(!options.fixture)throw new Error("FIXTURE_DISABLED");fixtureDropResponse=true;},setFixtureOffline(value:boolean){if(!options.fixture)throw new Error("FIXTURE_DISABLED");fixtureOffline=value;},context,stateDirectory:ready.stateDirectory,isAlive:()=>!exited,
   async review(sessionId:unknown,runId:unknown){
    if(fixtureOffline)throw new Error("TRANSPORT_UNAVAILABLE");
    const envelope=harnessClientRequestSchema.parse({protocolVersion:1,requestId:`review_${randomUUID()}`,connectionId:hello.connectionId,command:{method:"run.get",projectId:hello.projectId,sessionId,runId,includeReview:true}});
    const response=await requestHarnessLocalService(credentials,"command",envelope);
    if(!response.ok||response.data.kind!=="run")throw new Error("REVIEW_UNAVAILABLE");
    return tickets.issue(sessionId as string,projectApprovalReview(response.data.run,redact.text));
   },
   async resolveReview(ticketId:unknown,approve:unknown){
    if(fixtureOffline)throw new Error("TRANSPORT_UNAVAILABLE");
    const command=tickets.consume(ticketId,approve);
    const envelope=harnessClientRequestSchema.parse({protocolVersion:1,requestId:`decision_${randomUUID()}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
    return redact.response(await requestHarnessLocalService(credentials,"command",envelope));
   },
   async command(command:unknown){
    if(fixtureOffline)throw new Error("TRANSPORT_UNAVAILABLE");
    if(!command||typeof command!=="object"||Array.isArray(command)||"projectId" in command)throw new Error("INVALID_COMMAND");
    const parsed=harnessClientRequestSchema.safeParse({protocolVersion:1,requestId:`desktop_${randomUUID()}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
    if(!parsed.success)throw new Error("INVALID_COMMAND");
    const response=await requestHarnessLocalService(credentials,"command",parsed.data);
    if(fixtureDropResponse&&parsed.data.command.method==="run.start"){fixtureDropResponse=false;throw new Error("TRANSPORT_RESPONSE_LOST");}
    return redact.response(response);
   },
   async events(payload:unknown){
    if(fixtureOffline)throw new Error("TRANSPORT_UNAVAILABLE");
    const parsed=z.object({sessionId:z.string().min(1).max(160),after:z.number().int().nonnegative()}).strict().safeParse(payload);
    if(!parsed.success)throw new Error("INVALID_CURSOR");
    return redact.redact(await requestHarnessLocalService(credentials,"events",{projectId:hello.projectId,...parsed.data})) as Awaited<ReturnType<typeof requestHarnessLocalService<"events">>>;
   },
   async controlClose(operation:"pause"|"resume"|"cancel"):Promise<boolean>{
    if(exited)return false;
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
     const listener=(message:{kind?:string;requestId?:string;ok?:boolean;busy?:boolean})=>{if(message.kind!=="close-control-ack"||message.requestId!==requestId)return;clearTimeout(timer);worker.off("message",listener);if(message.ok)resolve(message.busy===true);else reject(new Error("CLOSE_CONTROL_FAILED"));};
     const timer=setTimeout(()=>{worker.off("message",listener);reject(new Error("CLOSE_CONTROL_TIMEOUT"));},5000);
     worker.on("message",listener);worker.postMessage({kind:"close-control",requestId,operation});
    });
   },
   async close(){if(!exited){worker.postMessage("close");await stopped;}}
  };
 }catch(error){if(!exited)worker.kill();await stopped;throw error;}
}
export type ProjectRuntime=Awaited<ReturnType<typeof launchProjectRuntime>>;
