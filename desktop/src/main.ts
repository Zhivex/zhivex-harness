import {verifyDesktopOciSmoke} from "./smoke-oci-verification.js";
import {verifyDesktopRestartSmoke} from "./smoke-restart-verification.js";
import {verifyDesktopEffectCrashSmoke} from "./smoke-effect-crash-verification.js";
import {prepareDesktopShutdown} from "./shutdown.js";
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
let exitApproved=false;
let requestExit=()=>{exitApproved=true;app.quit();};
app.on("before-quit",event=>{if(!exitApproved){event.preventDefault();requestExit();}});
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
  if(!pending){pending=launchProjectRuntime(project,{buildDirectory,directory,fixture,fixtureOci:fixture&&process.argv.includes("--fixture-oci"),fixtureEffectCrash:fixture&&process.argv.includes("--fixture-effect-crash"),recover:true});runtimes.set(key,pending);void pending.catch(()=>{if(runtimes.get(key)===pending)runtimes.delete(key);});}
  return (await pending).context;
 };
 const runtime=async(key:unknown)=>{if(typeof key!=="string"||!runtimes.has(key))throw new Error("PROJECT_NOT_OPEN");return runtimes.get(key)!;};
 const index=path.join(buildDirectory,"index.html"),url=pathToFileURL(index).href;
 const window=new BrowserWindow({width:1120,height:760,minWidth:720,minHeight:520,show:false,backgroundColor:"#101315",title:"Zhivex Harness",webPreferences:{preload:path.join(buildDirectory,"preload.cjs"),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 mainWindow=window;
 const fixtureCloseChoices=fixture?(argument("--fixture-close-choices")??"").split(","):[];
 requestExit=()=>{
  if(closing||exitApproved)return;closing=true;
  void(async()=>{
   const hosts=await Promise.allSettled([...runtimes.values()]);
   const ready=hosts.flatMap(host=>host.status==="fulfilled"?[host.value]:[]);
   const approved=await prepareDesktopShutdown(ready,async()=>{
    const response=fixture?(fixtureCloseChoices.shift()==="cancel"?1:0):(await dialog.showMessageBox(window,{type:"question",title:"Hay trabajo en curso",message:"Hay operaciones activas en tus proyectos.",detail:"Podés volver a la app o solicitar su cancelación antes de salir. Cancelar no revierte los cambios ya realizados. Si no se detienen, la ventana permanecerá abierta.",buttons:["Volver a la app","Cancelar trabajos y salir"],defaultId:0,cancelId:0,noLink:true})).response;
    return response===1?"cancel":"stay";
   });
   if(approved){runtimes.clear();exitApproved=true;app.quit();}
  })().catch(async()=>{if(!fixture&&!window.isDestroyed())await dialog.showMessageBox(window,{type:"warning",title:"La aplicación sigue abierta",message:"No se confirmó que todo el trabajo haya terminado.",detail:"Revisá el estado de tus proyectos antes de volver a salir. No se forzó el cierre ni se repitieron las operaciones.",buttons:["Volver a la app"]});}).finally(()=>{if(!exitApproved)closing=false;});
 };
 window.on("close",event=>{if(!exitApproved){event.preventDefault();requestExit();}});
 let recoveringRenderer=false;
 window.webContents.on("render-process-gone",()=>{
  if(closing||recoveringRenderer||window.isDestroyed())return;
  recoveringRenderer=true;
  void (async()=>{
   // Fixture selection is host-only; the production action is a native dialog.
   const response=fixture?0:(await dialog.showMessageBox(window,{type:"error",title:"La conversación dejó de responder",message:"La ventana de la conversación se cerró inesperadamente.",detail:"El servicio puede seguir trabajando. Recargar recupera el estado guardado y no vuelve a enviar tu tarea.",buttons:["Recargar conversación","Cerrar aplicación"],defaultId:0,cancelId:1,noLink:true})).response;
   if(closing||window.isDestroyed())return;
   if(response===0)window.webContents.reload();else app.quit();
  })().catch(()=>app.quit()).finally(()=>{recoveringRenderer=false;});
 });
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
  const value=payload as {projectKey:unknown;command:unknown};if(value.command&&typeof value.command==="object"&&"method" in value.command&&value.command.method==="approval.resolve")throw new Error("REVIEW_REQUIRED");return(await runtime(value.projectKey)).command(value.command);
 });
 ipcMain.handle("harness:review",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="projectKey,runId,sessionId")throw new Error("INVALID_REVIEW");
  const value=payload as {projectKey:unknown;sessionId:unknown;runId:unknown};return(await runtime(value.projectKey)).review(value.sessionId,value.runId);
 });
 ipcMain.handle("harness:resolve-review",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="approve,projectKey,ticketId")throw new Error("INVALID_DECISION");
  const value=payload as {projectKey:unknown;ticketId:unknown;approve:unknown};return(await runtime(value.projectKey)).resolveReview(value.ticketId,value.approve);
 });
 ipcMain.handle("harness:events",async(event,payload:unknown)=>{
  validateSender(event);if(!payload||typeof payload!=="object"||Array.isArray(payload)||Object.keys(payload).sort().join(",")!=="after,projectKey,sessionId")throw new Error("INVALID_CURSOR");
  const value=payload as {projectKey:unknown;sessionId:unknown;after:unknown};return(await runtime(value.projectKey)).events({sessionId:value.sessionId,after:value.after});
 });
 window.once("ready-to-show",()=>window.show());await window.loadFile(index);
 if(fixture&&reportDirectory){await mkdir(reportDirectory,{recursive:true});const restartPhase=argument("--fixture-restart-phase");if(restartPhase?.startsWith("effect-"))await verifyDesktopEffectCrashSmoke(window,runtimes,reportDirectory,restartPhase);else if(restartPhase)await verifyDesktopRestartSmoke(window,runtimes,reportDirectory,restartPhase,argument("--fixture-cli"));else{await (process.argv.includes("--fixture-oci")?verifyDesktopOciSmoke:verifyDesktopSmoke)(window,runtimes,reportDirectory);app.quit();}}
}).catch(async(error)=>{if(fixture)console.error(error);if(reportDirectory)await writeFile(path.join(reportDirectory,"failure.json"),JSON.stringify({code:"DESKTOP_VERIFICATION_FAILED"})).catch(()=>{});process.stderr.write("Desktop could not start or verify. Check workspace access and runtime ownership.\n");app.exit(1);});
app.on("window-all-closed",()=>app.quit());
