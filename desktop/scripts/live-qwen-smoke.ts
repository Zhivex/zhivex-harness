import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
if(!process.argv.includes("--live"))throw new Error("Pass --live to authorize bounded Qwen API calls.");
if(!process.env.DASHSCOPE_API_KEY&&!process.env.QWEN_API_KEY)throw new Error("QWEN_CREDENTIAL_MISSING");
const root=path.resolve(import.meta.dir,"..");const report=await mkdtemp("/tmp/har-qwen-live-");
const metadata=await Bun.file(path.join(root,"../package.json")).json();
const result=await Bun.build({entrypoints:[path.join(import.meta.dir,"live-qwen-runner.ts")],outdir:report,naming:"runner.cjs",target:"node",format:"cjs",external:["electron"],plugins:[{name:"metadata",setup(b){b.onLoad({filter:/[\\/]src[\\/]sqlite-database\.ts$/},async a=>({contents:(await Bun.file(a.path).text()).replace("createRequire(import.meta.url)","createRequire(process.execPath)"),loader:"ts"}));b.onLoad({filter:/[\\/]src[\\/]version\.ts$/},()=>({contents:`export const HARNESS_VERSION=${JSON.stringify(metadata.version)};export const NODE_ENGINE_RANGE=${JSON.stringify(metadata.engines.node)};export const BUN_ENGINE_RANGE=${JSON.stringify(metadata.engines.bun)};`,loader:"ts"}));}}]});
if(!result.success)throw new Error("LIVE_RUNNER_BUILD_FAILED");
const reader=path.join(report,"credential-reader.ts"),helper=path.join(report,"credential-helper");
await writeFile(reader,`const value=process.env.DASHSCOPE_API_KEY||process.env.QWEN_API_KEY;if(process.argv[3]!=="qwen"||process.argv[2]!=="read"||!value)process.exit(1);process.stdout.write(JSON.stringify({status:"present",secret:value}));`,{mode:0o600});
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
await writeFile(helper,`#!/bin/sh\nexec ${quote(process.execPath)} --env-file=${quote(path.join(root,"../.env"))} ${quote(reader)} "$@"\n`,{mode:0o700});
const resources=path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/Resources");
const child=spawn(path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),[path.join(report,"runner.cjs"),path.join(resources,"app.asar/build"),helper,report],{detached:true,cwd:report,env:{PATH:process.env.PATH,HOME:report,ZHIVEX_HARNESS_MAX_STEPS:"5",ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS:"4000",ZHIVEX_HARNESS_TIMEOUT_MS:"150000"},stdio:"ignore"});
const timer=setTimeout(()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}},6*60000);
try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});const evidence=JSON.parse(await readFile(path.join(report,"report.json"),"utf8"));console.log(JSON.stringify({report,...evidence}));if(code!==0)process.exitCode=1;}finally{clearTimeout(timer);await rm(helper,{force:true});await rm(reader,{force:true});}
