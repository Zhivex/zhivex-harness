#!/usr/bin/env node
import { startCodeHost } from "./application/code/host.js";
import {runCredentialWorker} from './application/credential-process.js';
import { launchApplicationCoordinator } from './application/coordinator-launcher.js';

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--credential-worker') {await runCredentialWorker(async account => {const {AsyncEntry} = await import('@napi-rs/keyring'); const entry = new AsyncEntry('ai.zhivex.assistant', account, {linux: {store: 'secret-service'}}); return {read: () => entry.getPassword(), write: value => entry.setPassword(value)};}); return;}
  if (args[0] === '--application-directory') {if (args.length !== 2 || !args[1]) throw new Error('SERVICE_USAGE_INVALID'); await launchApplicationCoordinator(args[1]); return;}
  const values: Record<string,string> = {};let recover=false;
  for(let i=0;i<args.length;i++){
    const name=args[i]!;
    if(name==="--recover"){recover=true;continue;}
    if(!["--workspace","--directory","--provider","--model","--tool-policy"].includes(name)||!args[i+1]||values[name]!==undefined)throw new Error("SERVICE_USAGE_INVALID");
    values[name]=args[++i]!;
  }
  if(!values["--workspace"]||!values["--directory"])throw new Error("SERVICE_USAGE_INVALID");
  const service=await startCodeHost({workspace:values["--workspace"],directory:values["--directory"],recover, engine:{...(values["--tool-policy"]?{toolPolicyFile:values["--tool-policy"]}:{}),...(values["--provider"]?{provider:values["--provider"]}:{}),...(values["--model"]?{model:values["--model"]}:{})}});
    process.stdout.write(JSON.stringify({schemaVersion:1,kind:"service-ready",credentialsPath:service.credentialsPath})+"\n");
    const stop=()=>{void service.close().catch(()=>{process.stderr.write('{"kind":"service-error","code":"SERVICE_SHUTDOWN_FAILED"}\n');process.exitCode=1;});};
    process.once("SIGINT",stop);process.once("SIGTERM",stop);

};
void main().catch(()=>{process.stderr.write('{"kind":"service-error","code":"SERVICE_START_FAILED"}\n');process.exitCode=1;});
