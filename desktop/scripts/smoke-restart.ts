import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root=path.resolve(import.meta.dir,".."),packaged=process.argv.includes("--packaged");
const activeClose=process.argv.includes("--active-close"),effectCrash=process.argv.includes("--effect-crash");
if(activeClose&&effectCrash)throw new Error("CHOOSE_ONE_SCENARIO");
const output=await mkdtemp("/tmp/har-restart-"),workspace=path.join(output,"repo"),report=path.join(output,"report");
await mkdir(workspace);await mkdir(report);
execFileSync("git",["init","-q",workspace],{env:{PATH:process.env.PATH!,HOME:output}});
await writeFile(path.join(workspace,"review.txt"),"context\r\nbefore\r\nlast");
const executable=packaged?path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness"):path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const phases:Array<{phase:string;appPid:number;runtimePid:number;sessionId:string;runId:string;packaged:boolean;windowCloseRequested:boolean}>=[];
for(const phase of effectCrash?["effect-crash","effect-recovery"]:activeClose?["active-close","cancelled-history"]:["prepare","approve","history"]){
 const child=spawn(executable,[...(packaged?[]:[root]),...(["prepare","active-close","effect-crash"].includes(phase)?["--workspace",workspace]:[]),"--smoke-test",...(phase==="effect-crash"?["--fixture-effect-crash"]:[]),"--fixture-restart-phase",phase,"--fixture-close-choices","stay,cancel","--fixture-cli",path.join(root,"../dist/cli.js"),"--report-directory",report],{cwd:output,env:{PATH:process.env.PATH!,HOME:output},stdio:["ignore","pipe","pipe"]});
 let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.stdout.resume();
 const timer=setTimeout(()=>child.kill("SIGKILL"),effectCrash?90000:30000);
 try{
  const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});assert.equal(code,0,`${phase}: ${stderr}`);
  const evidence=JSON.parse(await readFile(path.join(report,`${phase}-report.json`),"utf8"));assert.equal(evidence.phase,phase);assert.equal(evidence.packaged,packaged);assert(evidence.windowCloseRequested);assert.equal(evidence.appPid,child.pid);
  if(["approve","history","cancelled-history"].includes(phase))assert(evidence.cliSessionMatched);if(phase==="history")assert(evidence.cliRenameVisible);
  if(phase==="prepare")assert(evidence.rendererCrashRecovered);
  if(phase==="effect-crash")assert(evidence.effectBeforeJournalCrash);
  if(phase==="effect-recovery")assert(evidence.outcomeUnknown&&evidence.noAppliedDiff&&evidence.duplicateApprovalRejected&&evidence.explicitCancellation&&evidence.continuedWithoutReplay);
  if(phase==="history")assert(evidence.persistedFinalDiff&&evidence.laterChangesExcluded);
  if(phase==="active-close")assert(evidence.stayPreservedActiveRun&&evidence.quitCancellationRequested);
  if(phase==="cancelled-history")assert(evidence.cancelledRunRecovered&&evidence.noReplay);
  for(const pid of [evidence.appPid,evidence.runtimePid])assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==="ESRCH",`${phase} left process ${pid} alive`);
  phases.push(evidence);
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
}
assert.equal(new Set(phases.map(phase=>phase.appPid)).size,phases.length);assert.equal(new Set(phases.map(phase=>phase.runtimePid)).size,phases.length);assert.equal(new Set(phases.map(phase=>phase.sessionId)).size,1);assert.equal(new Set(phases.map(phase=>phase.runId)).size,1);
const evidence={schemaVersion:1,packaged,platform:process.platform,arch:process.arch,fixture:true,...(effectCrash?{effectBeforeJournalCrash:true,outcomeUnknown:true,noAppliedDiff:true,duplicateApprovalRejected:true,continuedWithoutReplay:true}:activeClose?{activeClose:true,stayPreservedActiveRun:true,quitCancellationCompleted:true,cancelledRunRecovered:true,noReplay:true}:{rendererCrashRecovered:true,pendingApprovalPreserved:true,oldReviewReceiptRejected:true,freshExplicitApproval:true,singleAppliedDecisionAfterRestart:true,cliPendingAndCompletedSessionMatched:true,cliRenameVisibleInDesktop:true}),wholeAppRestart:true,nativeWindowClose:true,workersExited:true,recentProjectRestored:true,phases};
await writeFile(path.join(report,"report.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify({...evidence,evidenceDirectory:report}));
