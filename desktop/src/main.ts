import { app, BrowserWindow, ipcMain, utilityProcess, session } from "electron";
import { realpath, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "../../src/local-service.js";
import { harnessClientRequestSchema } from "../../src/client-contract.js";
import type { DesktopContext } from "./bridge.js";

const argument=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const fixture=process.argv.includes("--smoke-test");
const workspaceArgument=argument("--workspace");
const reportDirectory=fixture?argument("--report-directory"):undefined;
if(fixture&&reportDirectory)app.setPath("userData",path.join(reportDirectory,"user-data"));
let worker:Electron.UtilityProcess|undefined;
let closing=false;
app.on("before-quit",event=>{if(worker&&!closing){event.preventDefault();closing=true;worker.postMessage("close");worker.once("exit",()=>{worker=undefined;app.quit();});}});
void app.whenReady().then(async()=>{
 if(!workspaceArgument)throw new Error("Select a workspace with --workspace for this spike.");
 const workspace=await realpath(workspaceArgument);
 const directory=fixture&&reportDirectory?path.join(reportDirectory,"socket"):`/tmp/zhx-desktop-${process.getuid?.()}`;
 worker=utilityProcess.fork(path.join(app.getAppPath(),"build","runtime.cjs"),[JSON.stringify({workspace,directory,fixture,recover:process.argv.includes("--recover")})],{serviceName:"Zhivex Harness runtime",stdio:"pipe"});
 if(fixture)worker.stderr?.on("data",chunk=>process.stderr.write(chunk));
 const ready=await new Promise<{credentialsPath:string;pid:number;node:string;stateDirectory:string}>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("RUNTIME_START_TIMEOUT")),15000);
  worker!.once("message",message=>{if(fixture&&message?.kind!=="ready")console.error(message);clearTimeout(timer);if(message?.kind==="ready")resolve(message);else reject(new Error("RUNTIME_START_FAILED"));});
  worker!.once("exit",()=>{clearTimeout(timer);reject(new Error("RUNTIME_EXITED"));});
 });
 const credentials=await readHarnessLocalCredentials(ready.credentialsPath);
 const hello=await requestHarnessLocalService(credentials,"hello",{versions:[1]});if(!hello.ok)throw new Error("PROTOCOL_UNSUPPORTED");
 const context:DesktopContext={workspace,projectId:hello.projectId,runtimePid:ready.pid,runtimeNode:ready.node,fixture};
 const index=path.join(app.getAppPath(),"build","index.html"),url=pathToFileURL(index).href;
 const window=new BrowserWindow({width:1120,height:760,minWidth:720,minHeight:520,show:false,backgroundColor:"#101315",title:"Zhivex Harness",webPreferences:{preload:path.join(app.getAppPath(),"build","preload.cjs"),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 const validateSender=(event:Electron.IpcMainInvokeEvent)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)throw new Error("UNTRUSTED_SENDER");};
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 window.webContents.setWindowOpenHandler(()=>({action:"deny"}));
 window.webContents.on("will-navigate",event=>event.preventDefault());
 window.webContents.on("will-attach-webview",event=>event.preventDefault());
 ipcMain.handle("harness:context",event=>{validateSender(event);return context;});
 ipcMain.handle("harness:command",async(event,command:unknown)=>{
  validateSender(event);
  if(!command||typeof command!=="object"||Array.isArray(command)||"projectId" in command)throw new Error("INVALID_COMMAND");
  const envelope=harnessClientRequestSchema.safeParse({protocolVersion:1,requestId:`desktop_${randomUUID()}`,connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
  if(!envelope.success)throw new Error("INVALID_COMMAND");
  return requestHarnessLocalService(credentials,"command",envelope.data);
 });
 ipcMain.handle("harness:events",async(event,payload:unknown)=>{
  validateSender(event);const parsed=z.object({sessionId:z.string().min(1).max(160),after:z.number().int().nonnegative()}).strict().safeParse(payload);
  if(!parsed.success)throw new Error("INVALID_CURSOR");
  return requestHarnessLocalService(credentials,"events",{projectId:hello.projectId,...parsed.data});
 });
 window.once("ready-to-show",()=>window.show());
 await window.loadFile(index);
 if(fixture&&reportDirectory){
  await mkdir(reportDirectory,{recursive:true});
  const wait=async(expression:string)=>{for(let i=0;i<100;i++){if(await window.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error("RENDERER_TIMEOUT");};
  await wait('document.querySelector("[data-ready=true]") !== null');
  const isolated=await window.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined" && Object.keys(window.harness).sort().join(",") === "command,context,events"');
  if(!isolated||ready.pid===process.pid)throw new Error("ISOLATION_FAILED");
  const rejectedOverrides=await window.webContents.executeJavaScript(`Promise.all([
    window.harness.command({method:"project.get",projectId:"forged"}).then(()=>false,()=>true),
    window.harness.command({method:"project.get",workspace:"/"}).then(()=>false,()=>true)
  ]).then(results=>results.every(Boolean))`);
  if(!rejectedOverrides)throw new Error("BRIDGE_VALIDATION_FAILED");
  await window.webContents.executeJavaScript('document.querySelector("[data-action=start]").click()');
  await wait('document.body.innerText.includes("completed")');
  await window.webContents.executeJavaScript('document.querySelector("[data-action=wait]").click()');
  await wait('document.querySelector("[data-action=cancel]").disabled === false');
  await window.webContents.executeJavaScript('document.querySelector("[data-action=cancel]").click()');
  await wait('document.body.innerText.includes("cancelled")');
  const database=await stat(path.join(ready.stateDirectory,"operations.sqlite"));if(database.size===0)throw new Error("SQLITE_EMPTY");
  await writeFile(path.join(reportDirectory,"screenshot.png"),(await window.webContents.capturePage()).toPNG());
  await writeFile(path.join(reportDirectory,"report.json"),JSON.stringify({schemaVersion:1,platform:process.platform,arch:process.arch,electron:process.versions.electron,hostNode:process.versions.node,runtimeNode:ready.node,separateProcess:true,isolatedRenderer:isolated,rejectedOverrides,sqliteBytes:database.size,streaming:true,cancellation:true,packaged:app.isPackaged,fixture:true},null,2));
  app.quit();
 }
}).catch(async(error)=>{if(fixture)console.error(error);if(reportDirectory)await writeFile(path.join(reportDirectory,"failure.json"),JSON.stringify({code:"DESKTOP_SPIKE_FAILED"})).catch(()=>{});process.stderr.write("Desktop could not start or verify. Check the workspace, runtime ownership and provider configuration.\n");app.exit(1);});
app.on("window-all-closed",()=>app.quit());
