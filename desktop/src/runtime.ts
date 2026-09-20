import { hostSensitiveValues } from "./redaction.js";
import { createHarness } from "../../src/harness.js";
import { startHarnessLocalService, recoverHarnessLocalService } from "../../src/local-service.js";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { LanguageModel } from "@zhivex-ai/agents";

const parent = (process as NodeJS.Process & {parentPort: { postMessage(value: unknown):void; on(event: "message", listener: (event:{data:unknown})=>void):void }}).parentPort;
async function boot() {
 const config=JSON.parse(process.argv[2]!) as {workspace:string;directory:string;fixture:boolean;recover:boolean};
 const base=createMockLanguageModel();
 const mock:LanguageModel={...base,async stream(input){return(async function*(){
  const userIndex=input.messages.findLastIndex(m=>m.role==="user");const prompt=JSON.stringify(input.messages[userIndex]??{});
  const probe=prompt.includes("activity-probe");
  const hasResult=input.messages.slice(userIndex+1).some(m=>m.role==="tool");
  if(probe&&!hasResult){
   yield{type:"tool-call" as const,toolCall:{id:"probe-read",name:"read_file",input:{path:"package.json"}}};
   yield{type:"tool-call" as const,toolCall:{id:"probe-check",name:"run_check",input:{check:"test",expectedScript:"bun -e 'process.exit(7)'"}}};
   yield{type:"finish" as const,finishReason:"tool-calls" as const};return;
  }
  yield{type:"text-delta" as const,textDelta:"Runtime separado: SQLite y streaming disponibles. "};
  if(prompt.includes("wait-for-cancel"))await new Promise<void>(resolve=>{if(input.abortSignal?.aborted)resolve();else input.abortSignal?.addEventListener("abort",()=>resolve(),{once:true});});
  if(probe){
   const secret=process.env.ZHIVEX_HARNESS_DESKTOP_FIXTURE_SECRET??"fixture-secret";
   yield{type:"text-delta" as const,textDelta:"Contenido literal <img src=x onerror=alert(1)> "};
   yield{type:"text-delta" as const,textDelta:secret.slice(0,8)};yield{type:"text-delta" as const,textDelta:secret.slice(8)+" "};
   for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,25));yield{type:"text-delta" as const,textDelta:`parte-${i} `};}
  }
  yield{type:"finish" as const,finishReason:"stop" as const};
 })();}};
 const harness=await createHarness({workspace:config.workspace,provider:"openai",...(config.fixture?{modelInstance:mock}:{}),subagentProfiles:[]});
 try {
  if(config.recover)await recoverHarnessLocalService(harness,config.directory);
  const service=await startHarnessLocalService(harness,{directory:config.directory,sensitiveValues:hostSensitiveValues(process.env),...(config.fixture?{maxEvents:8}:{})});
  parent.postMessage({kind:"ready",credentialsPath:service.credentialsPath,pid:process.pid,node:process.versions.node,stateDirectory:harness.config.stateDirectory});
  let closing=false;parent.on("message",event=>{if(event.data==="close"&&!closing){closing=true;void service.close().then(()=>process.exit(0),()=>process.exit(1));}});
 }catch(error){await harness.close();throw error;}
}
void boot().catch(error=>{if(JSON.parse(process.argv[2]!).fixture)console.error(error);parent.postMessage({kind:"failed",code:"RUNTIME_START_FAILED"});process.exitCode=1;});
