import {app,BrowserWindow,ipcMain} from "electron";
import {mkdir,writeFile,readFile,readdir} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {launchProjectRuntime,type ProjectRuntime} from "../src/runtime-host.js";
import {desktopProviders} from "../src/model-selection.js";
import {hostSensitiveValues} from "../src/redaction.js";
const [build,helper,report]=process.argv.slice(2) as [string,string,string];
app.setPath("userData",path.join(report,"profile"));
let host:ProjectRuntime|undefined;
void app.whenReady().then(async()=>{
 const repo=path.join(report,"repo");await mkdir(repo);execFileSync("/usr/bin/git",["init","-q",repo]);
 const shim=path.join(report,"native-read");await writeFile(shim,`#!/bin/sh\nexec '${helper.replace(/'/g,"'\\''")}' self-test-read\n`,{mode:0o700});
 const project={key:"native-keychain-fixture",workspace:repo,name:"Keychain integration",lastOpenedAt:Date.now()};
 // Production runtime (no fixture model) can open an unconfigured project without a network request.
 const missing=path.join(report,"missing-credential");await writeFile(missing,`#!/bin/sh\nprintf '%s\\n' '{"status":"missing"}'\n`,{mode:0o700});
 const unconfigured=await launchProjectRuntime({...project,modelSelection:{provider:"qwen",model:"qwen3.8-max"}},{buildDirectory:build,directory:path.join(report,"unconfigured-socket"),stateDirectory:path.join(report,"unconfigured-state"),credentialHelper:missing,fixture:false,recover:true});
 try {
  assert.equal(unconfigured.context.credentialConfigured,false);
  const opened=await unconfigured.command({method:"session.create",idempotencyKey:"without-key"});assert(opened.ok&&opened.data.kind==="session");
  await assert.rejects(unconfigured.command({method:"run.start",sessionId:opened.data.session.sessionId,expectedRevision:opened.data.session.revision,idempotencyKey:"blocked-no-key",prompt:"must not run"}),/MODEL_CREDENTIAL_REQUIRED/);
 } finally {await unconfigured.close();}
 const start=()=>launchProjectRuntime(project,{buildDirectory:build,directory:path.join(report,"socket"),stateDirectory:path.join(report,"state"),fixture:true,fixtureCredentialHelper:shim,recover:true});
 host=await start();assert.deepEqual(host.fixtureCredentialProof(),{verified:true,argvClean:true,envClean:true});
 const window=new BrowserWindow({width:1120,height:760,show:false,webPreferences:{preload:path.join(build,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 ipcMain.handle("harness:providers",()=>desktopProviders());ipcMain.handle("harness:initial-project",()=>host!.context);ipcMain.handle("harness:projects",()=>[project]);ipcMain.handle("harness:command",(_event,payload)=>host!.command(payload.command));ipcMain.handle("harness:events",(_event,payload)=>host!.events({sessionId:payload.sessionId,after:payload.after}));ipcMain.handle("harness:tasks",()=>[]);
 await window.loadFile(path.join(build,"index.html"));const js=(s:string)=>window.webContents.executeJavaScript(s);
 const wait=async(s:string)=>{for(let i=0;i<200;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,25));}throw new Error("NATIVE_CREDENTIAL_UI_TIMEOUT");};
 await wait('document.querySelector("[data-action=new-session]")?.disabled===false');await js('document.querySelector("[data-action=new-session]").click()');await wait('document.querySelector("#prompt")?.disabled===false');
 await js('const input=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Native credential integration");input.dispatchEvent(new Event("input",{bubbles:true}));');await wait('document.querySelector("[data-action=start]").disabled===false');await js('document.querySelector("[data-action=start]").click()');await wait('document.body.innerText.includes("completed") && document.body.innerText.includes("Runtime separado")');
 const firstSecrets=[...hostSensitiveValues({})];assert.equal(firstSecrets.length,1);const firstPid=host.context.runtimePid;
 await host.close();host=await start();assert.deepEqual(host.fixtureCredentialProof(),{verified:true,argvClean:true,envClean:true});assert.notEqual(host.context.runtimePid,firstPid);
 const loaded=new Promise<void>(resolve=>window.webContents.once("did-finish-load",()=>resolve()));window.webContents.reload();await loaded;await wait('document.querySelectorAll("[data-session]").length===1');await js('document.querySelector("[data-session]").click()');await wait('document.body.innerText.includes("completed")');
 const secrets=hostSensitiveValues({});assert.equal(secrets.length,2);assert.notEqual(secrets[0],secrets[1]);const renderer=await js('JSON.stringify({text:document.body.innerText,storage:{...localStorage},bridge:Object.keys(window.harness)})');for(const secret of secrets)assert(!renderer.includes(secret));
 await host.close();host=undefined;
 const scan=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true})){const filename=path.join(dir,entry.name);if(entry.isDirectory())await scan(filename);else if(entry.isFile()){const bytes=await readFile(filename);for(const secret of secrets)assert(!bytes.includes(Buffer.from(secret)),"SECRET_IN_STATE");}}};await scan(path.join(report,"state"));await scan(path.join(report,"profile"));
 const evidence={packagedRuntime:build.includes("app.asar"),nativeTemporaryKeychain:true,hostAdapter:true,privateBootstrapVerified:true,noSecretArgvOrEnvironment:true,rendererRunCompleted:true,restartedWithDifferentKey:true,conversationRecovered:true,rendererAndStorageClean:true,stateFilesClean:true,noProviderNetwork:true,unconfiguredProductionRuntime:true,missingKeyBlocksGeneration:true};await writeFile(path.join(report,"report.json"),JSON.stringify(evidence,null,2));app.exit(0);
}).catch(async()=>{await host?.close().catch(()=>{});console.error("NATIVE_CREDENTIAL_INTEGRATION_FAILED");app.exit(1);});
