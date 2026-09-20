import { spawn,execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile,writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root=path.resolve(import.meta.dir,"..");
const packaged=process.argv.includes("--packaged"),empty=process.argv.includes("--empty-start"),oci=process.argv.includes("--oci-review");
if(oci&&empty)throw new Error("OCI_REVIEW_REQUIRES_WORKSPACE");
const output=await mkdtemp("/tmp/har-electron-");
const workspace=path.join(output,"repo"),report=path.join(output,"report");await mkdir(workspace);await mkdir(report);const second=path.join(output,"second-repo");await mkdir(second);for(const repo of [workspace,second])execFileSync("git",["init","-q",repo],{env:{PATH:process.env.PATH!,HOME:output}});
const executable=packaged?path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness"):path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
await writeFile(path.join(workspace,"package.json"),JSON.stringify({name:"desktop-fixture",private:true,packageManager:"bun@1.4.0",scripts:{test:"bun -e 'process.exit(7)'"}}));
await writeFile(path.join(workspace,"review.txt"),oci?"before\n":"context\r\nbefore\r\nlast");
const invalid=path.join(output,"not-a-repo");await mkdir(invalid);
const args=[...(packaged?[]:[root]),...(empty?[]:["--workspace",workspace]),"--smoke-test",...(oci?["--fixture-oci"]:[]),"--report-directory",report,...(empty?["--fixture-project",workspace]:[]),"--fixture-project",invalid,"--fixture-project",second];
const child=spawn(executable,args,{cwd:output,env:{PATH:process.env.PATH!,HOME:output,ZHIVEX_HARNESS_DESKTOP_FIXTURE_SECRET:"desktop-fixture-private-value-2837"},stdio:["ignore","pipe","pipe"]});
let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.stdout.resume();
const timer=setTimeout(()=>child.kill("SIGKILL"),45000);
try{
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
 assert.equal(code,0,stderr);
 const evidence=JSON.parse(await readFile(path.join(report,"report.json"),"utf8"));
 assert.equal(evidence.packaged,packaged);if(oci){assert(evidence.fixtureRuntime&&!evidence.realDocker&&evidence.completePreview&&evidence.explicitApproval&&evidence.hostBytesVerified&&evidence.patchBoundEvidence);}else{assert(evidence.separateProcess&&evidence.isolatedRenderer&&evidence.rejectedOverrides&&evidence.streaming&&evidence.cancellation);assert(evidence.sqliteBytes>0);assert(evidence.projectIsolation&&evidence.selectionHasNoExecution&&evidence.keyboardNavigation&&evidence.rendererReload&&evidence.recentProjects===2&&evidence.invalidProjectRecovery&&evidence.singleInstance);assert.equal(evidence.emptyStartup,empty);assert(evidence.decisionHistoryReload&&evidence.expiredApprovalRejected&&evidence.staleApprovalRejected);assert(evidence.fileApprovalUI&&evidence.fileRejectionUI&&evidence.completePreimage);assert(evidence.duplicateSubmitPrevented&&evidence.lostResponseReconciled&&evidence.failedCheckVisible&&evidence.redactedRenderer&&evidence.literalRepositoryText&&evidence.activeReconnect&&evidence.expiredSnapshot);}
 console.log(JSON.stringify({...evidence,evidenceDirectory:report}));
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
