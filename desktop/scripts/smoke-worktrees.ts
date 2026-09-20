import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root=path.resolve(import.meta.dir,".."),packaged=process.argv.includes("--packaged");
const output=await mkdtemp("/tmp/har-tasks-"),workspace=path.join(output,"repo"),report=path.join(output,"report");await mkdir(workspace);await mkdir(report);
const env={PATH:process.env.PATH!,HOME:output,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};
const git=(args:string[])=>execFileSync("git",["-C",workspace,...args],{env,encoding:"utf8"});
git(["init","-q"]);git(["config","user.name","Fixture"]);git(["config","user.email","fixture@example.test"]);await writeFile(path.join(workspace,"review.txt"),"baseline\n");git(["add","review.txt"]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","baseline"]);
await writeFile(path.join(workspace,"review.txt"),"staged original\n");git(["add","review.txt"]);await writeFile(path.join(workspace,"review.txt"),"unstaged original\n");await writeFile(path.join(workspace,"untracked.txt"),"preserve\n");
const status=git(["status","--porcelain=v1"]),index=await readFile(path.join(workspace,".git/index"));
const executable=packaged?path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness"):path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const phases=[];
for(const phase of ["tasks-create","tasks-reopen"]){
 const child=spawn(executable,[...(packaged?[]:[root]),...(phase==="tasks-create"?["--workspace",workspace]:[]),"--smoke-test","--fixture-drop-git-response","--fixture-restart-phase",phase,"--report-directory",report],{cwd:output,env,stdio:["ignore","pipe","pipe"]});let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.stdout.resume();const timer=setTimeout(()=>child.kill("SIGKILL"),60000);
 try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});assert.equal(code,0,`${phase}: ${stderr}`);const evidence=JSON.parse(await readFile(path.join(report,`${phase}-report.json`),"utf8"));assert.equal(evidence.packaged,packaged);for(const pid of [evidence.appPid,...evidence.runtimePids])assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==="ESRCH");phases.push(evidence);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
 const checkpoint=JSON.parse(await readFile(path.join(report,"tasks-checkpoint.json"),"utf8"));assert.equal(git(["rev-list","--count",checkpoint[0].task.branch]).trim(),"2");assert.equal(git(["rev-list","--count",checkpoint[1].task.branch]).trim(),"1");assert.equal(git(["rev-list","--count","HEAD"]).trim(),"1");
 assert.equal(await readFile(path.join(workspace,"review.txt"),"utf8"),"unstaged original\n");assert.equal(await readFile(path.join(workspace,"untracked.txt"),"utf8"),"preserve\n");assert.deepEqual(await readFile(path.join(workspace,".git/index")),index);
}
assert.equal(git(["status","--porcelain=v1"]).split("\n").filter(line=>!line.includes(".zhivex-harness")).join("\n"),status);
const evidence={schemaVersion:1,packaged,fixture:true,originalChangesPreserved:true,concurrentTaskIsolation:true,singleReviewedCommit:true,originalBranchUnchanged:true,wholeAppRestart:true,reviewedCleanup:true,workersExited:true,phases,evidenceDirectory:report};await writeFile(path.join(report,"report.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
