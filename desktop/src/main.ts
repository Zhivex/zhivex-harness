import { app, BrowserWindow, ipcMain, session, dialog } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openProjectRegistry } from "./projects.js";
import { launchProjectRuntime, type ProjectRuntime } from "./runtime-host.js";
import { verifyDesktopSmoke } from "./smoke-verification.js";

const argument=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const fixture=process.argv.includes("--smoke-test"),workspaceArgument=argument("--workspace");
const reportDirectory=fixture?argument("--report-directory"):undefined;
if(fixture&&reportDirectory)app.setPath("userData",path.join(reportDirectory,"user-data"));
if(!app.requestSingleInstanceLock())app.exit(0);
let mainWindow:BrowserWindow|undefined;
app.on("second-instance",()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
const runtimes=new Map<string,Promise<ProjectRuntime>>();let closing=false;
app.on("before-quit",event=>{if(runtimes.size&&!closing){event.preventDefault();closing=true;void Promise.allSettled([...runtimes.values()].map(async pending=>(await pending).close())).then(()=>{runtimes.clear();app.quit();});}});
void app.whenReady().then(async()=>{
 const registry=await openProjectRegistry(path.join(app.getPath("userData"),"projects"));
 const directory=fixture&&reportDirectory?path.join(reportDirectory,"socket"):`/tmp/zhx-desktop-${process.getuid?.()}`;
 const buildDirectory=path.join(app.getAppPath(),"build");
 const connect=async(key:string)=>{
  if(closing)throw new Error("APPLICATION_CLOSING");
  const known=registry.get(key);
  const project=await registry.select(known.workspace);
  if(project.key!==key)throw new Error("PROJECT_IDENTITY_CHANGED");
  let pending=runtimes.get(key);
  if(pending&&!((await pending).isAlive())){runtimes.delete(key);pending=undefined;}
  if(!pending){pending=launchProjectRuntime(project,{buildDirectory,directory,fixture,recover:process.argv.includes("--recover")});runtimes.set(key,pending);void pending.catch(()=>{if(runtimes.get(key)===pending)runtimes.delete(key);});}
  return (await pending).context;
 };
 const runtime=async(key:unknown)=>{if(typeof key!=="string"||!runtimes.has(key))throw new Error("PROJECT_NOT_OPEN");return runtimes.get(key)!;};
 const index=path.join(buildDirectory,"index.html"),url=pathToFileURL(index).href;
 const window=new BrowserWindow({width:1120,height:760,minWidth:720,minHeight:520,show:false,backgroundColor:"#101315",title:"Zhivex Harness",webPreferences:{preload:path.join(buildDirectory,"preload.cjs"),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 mainWindow=window;
 const validateSender=(event:Electron.IpcMainInvokeEvent)=>{if(closing||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)throw new Error("UNTRUSTED_SENDER");};
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 window.webContents.setWindowOpenHandler(()=>({action:"deny"}));window.webContents.on("will-navigate",event=>event.preventDefault());window.webContents.on("will-attach-webview",event=>event.preventDefault());
 ipcMain.handle("harness:projects",event=>{validateSender(event);return registry.list();});
 ipcMain.handle("harness:initial-project",async event=>{validateSender(event);return workspaceArgument?connect((await registry.select(workspaceArgument)).key):null;});
 ipcMain.handle("harness:open-project",async(event,key:unknown)=>{validateSender(event);if(typeof key!=="string")throw new Error("INVALID_PROJECT");return connect(key);});
 const fixtureProjects=fixture?process.argv.flatMap((value,index)=>value==="--fixture-project"&&process.argv[index+1]?[process.argv[index+1]!]:[]):[];
 let choosing=false;
 ipcMain.handle("harness:choose-project",async event=>{
  validateSender(event);if(choosing)throw new Error("PROJECT_PICKER_BUSY");choosing=true;
  try{
   // Only host-launch fixture paths can replace the native picker in packaged tests.
   const fixturePath=fixtureProjects.shift();
   const result=fixture?{canceled:!fixturePath,filePaths:fixturePath?[fixturePath]:[]}:await dialog.showOpenDialog(window,{title:"Abrir repositorio",buttonLabel:"Abrir proyecto",properties:["openDirectory"]});
   if(result.canceled||!result.filePaths[0])return null;
   return connect((await registry.select(result.filePaths[0])).key);
  }finally{choosing=false;}
 });
 ipcMain.handle("harness:command",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="command,projectKey")throw new Error("INVALID_COMMAND");
  const value=payload as {projectKey:unknown;command:unknown};return(await runtime(value.projectKey)).command(value.command);
 });
 ipcMain.handle("harness:review",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="projectKey,runId,sessionId")throw new Error("INVALID_REVIEW");
  const value=payload as {projectKey:unknown;sessionId:unknown;runId:unknown};return(await runtime(value.projectKey)).review(value.sessionId,value.runId);
 });
 ipcMain.handle("harness:events",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="after,projectKey,sessionId")throw new Error("INVALID_CURSOR");
  const value=payload as {projectKey:unknown;sessionId:unknown;after:unknown};return(await runtime(value.projectKey)).events({sessionId:value.sessionId,after:value.after});
 });
 window.once("ready-to-show",()=>window.show());await window.loadFile(index);
 if(fixture&&reportDirectory){await mkdir(reportDirectory,{recursive:true});await verifyDesktopSmoke(window,runtimes,reportDirectory);app.quit();}
}).catch(async(error)=>{if(fixture)console.error(error);if(reportDirectory)await writeFile(path.join(reportDirectory,"failure.json"),JSON.stringify({code:"DESKTOP_VERIFICATION_FAILED"})).catch(()=>{});process.stderr.write("Desktop could not start or verify. Check workspace access and runtime ownership.\n");app.exit(1);});
app.on("window-all-closed",()=>app.quit());
