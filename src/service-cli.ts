#!/usr/bin/env node
import { createHarness } from "./runtime/harness.js";
import { startHarnessLocalService, recoverHarnessLocalService } from "./client/local-service.js";

const main = async () => {
  const args = process.argv.slice(2);const values: Record<string,string> = {};let recover=false;
  for(let i=0;i<args.length;i++){
    const name=args[i]!;
    if(name==="--recover"){recover=true;continue;}
    if(!["--workspace","--directory","--provider","--model"].includes(name)||!args[i+1]||values[name]!==undefined)throw new Error("SERVICE_USAGE_INVALID");
    values[name]=args[++i]!;
  }
  if(!values["--workspace"]||!values["--directory"])throw new Error("SERVICE_USAGE_INVALID");
  const harness=await createHarness({workspace:values["--workspace"],...(values["--provider"]?{provider:values["--provider"]}:{}),...(values["--model"]?{model:values["--model"]}:{})});
  try{
    if(recover)await recoverHarnessLocalService(harness,values["--directory"]);
    const service=await startHarnessLocalService(harness,{directory:values["--directory"]});
    process.stdout.write(JSON.stringify({schemaVersion:1,kind:"service-ready",credentialsPath:service.credentialsPath})+"\n");
    const stop=()=>{void service.close().catch(()=>{process.stderr.write('{"kind":"service-error","code":"SERVICE_SHUTDOWN_FAILED"}\n');process.exitCode=1;});};
    process.once("SIGINT",stop);process.once("SIGTERM",stop);
  }catch(e){await harness.close();throw e;}
};
void main().catch(()=>{process.stderr.write('{"kind":"service-error","code":"SERVICE_START_FAILED"}\n');process.exitCode=1;});
