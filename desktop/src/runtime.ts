import { createHarness } from "../../src/harness.js";
import { startHarnessLocalService, recoverHarnessLocalService } from "../../src/local-service.js";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { LanguageModel } from "@zhivex-ai/agents";

const parent = (process as NodeJS.Process & {parentPort: { postMessage(value: unknown):void; on(event: "message", listener: (event:{data:unknown})=>void):void }}).parentPort;
async function boot() {
 const config=JSON.parse(process.argv[2]!) as {workspace:string;directory:string;fixture:boolean;recover:boolean};
 const base=createMockLanguageModel();
 const mock:LanguageModel={...base,async stream(input){return(async function*(){
  yield{type:"text-delta" as const,textDelta:"Runtime separado: SQLite y streaming disponibles. "};
  if(input.messages.some(m=>JSON.stringify(m).includes("wait-for-cancel")))await new Promise<void>(resolve=>{if(input.abortSignal?.aborted)resolve();else input.abortSignal?.addEventListener("abort",()=>resolve(),{once:true});});
  yield{type:"finish" as const,finishReason:"stop" as const};
 })();}};
 const harness=await createHarness({workspace:config.workspace,provider:"openai",...(config.fixture?{modelInstance:mock}:{}),subagentProfiles:[]});
 try {
  if(config.recover)await recoverHarnessLocalService(harness,config.directory);
  const service=await startHarnessLocalService(harness,{directory:config.directory});
  parent.postMessage({kind:"ready",credentialsPath:service.credentialsPath,pid:process.pid,node:process.versions.node,stateDirectory:harness.config.stateDirectory});
  let closing=false;parent.on("message",event=>{if(event.data==="close"&&!closing){closing=true;void service.close().then(()=>process.exit(0),()=>process.exit(1));}});
 }catch(error){await harness.close();throw error;}
}
void boot().catch(error=>{if(JSON.parse(process.argv[2]!).fixture)console.error(error);parent.postMessage({kind:"failed",code:"RUNTIME_START_FAILED"});process.exitCode=1;});
