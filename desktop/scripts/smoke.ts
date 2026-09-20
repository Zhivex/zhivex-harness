import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root=path.resolve(import.meta.dir,"..");
const packaged=process.argv.includes("--packaged");
const output=await mkdtemp("/tmp/har-electron-");
const workspace=path.join(output,"repo"),report=path.join(output,"report");await mkdir(workspace);await mkdir(report);
const executable=packaged?path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness"):path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const args=[...(packaged?[]:[root]),"--workspace",workspace,"--smoke-test","--report-directory",report];
const child=spawn(executable,args,{cwd:output,env:{PATH:process.env.PATH!,HOME:output},stdio:["ignore","pipe","pipe"]});
let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.stdout.resume();
const timer=setTimeout(()=>child.kill("SIGKILL"),45000);
try{
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
 assert.equal(code,0,stderr);
 const evidence=JSON.parse(await readFile(path.join(report,"report.json"),"utf8"));
 assert.equal(evidence.packaged,packaged);assert(evidence.separateProcess&&evidence.isolatedRenderer&&evidence.rejectedOverrides&&evidence.streaming&&evidence.cancellation);assert(evidence.sqliteBytes>0);
 console.log(JSON.stringify({...evidence,evidenceDirectory:report}));
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
