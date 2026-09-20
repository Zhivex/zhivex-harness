import {verifyDesktopWorktreesSmoke} from "./smoke-worktrees-verification.js";
import {verifyDesktopOciSmoke} from "./smoke-oci-verification.js";
import {verifyDesktopRestartSmoke} from "./smoke-restart-verification.js";
import {verifyDesktopEffectCrashSmoke} from "./smoke-effect-crash-verification.js";
import {openTaskWorktrees,type ManagedTask} from "./task-worktrees.js";
import type {DesktopTask} from "./bridge.js";
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
 const tasks=await openTaskWorktrees(path.join(app.getPath("userData"),"tasks"));
 const taskView=(task:ManagedTask):DesktopTask=>({id:task.id,sourceProjectKey:task.sourceProjectKey,title:task.title,branch:task.branch,baseCommit:task.baseCommit,workspace:task.workspace,status:task.status});
 const taskOperations=new Set<Promise<unknown>>(),removing=new Set<string>();
 const trackTask=async<T>(operation:Promise<T>)=>{taskOperations.add(operation);try{return await operation;}finally{taskOperations.delete(operation);}};
 const sourceProject=(key:string)=>{const project=registry.get(key),task=tasks.list().find(task=>task.workspace===project.workspace);return task?registry.get(task.sourceProjectKey):project;};
 const directory=fixture&&reportDirectory?path.join(reportDirectory,"socket"):`/tmp/zhx-desktop-${process.getuid?.()}`;
 const buildDirectory=path.join(app.getAppPath(),"build");
 const connect=async(key:string)=>{
  if(closing)throw new Error("APPLICATION_CLOSING");
  const known=registry.get(key);
  const project=await registry.select(known.workspace);
  if(project.key!==key)throw new Error("PROJECT_IDENTITY_CHANGED");
  if(closing||removing.has(project.workspace))throw new Error("PROJECT_UNAVAILABLE");
  const task=tasks.list().find(task=>task.workspace===project.workspace);
  if(task)await tasks.inspect(task.id);
  if(closing||removing.has(project.workspace))throw new Error("PROJECT_UNAVAILABLE");
  let pending=runtimes.get(key);
  if(pending&&!((await pending).isAlive())){runtimes.delete(key);pending=undefined;}
  if(closing||removing.has(project.workspace))throw new Error("PROJECT_UNAVAILABLE");
  if(!pending){pending=launchProjectRuntime(project,{buildDirectory,directory,fixture,...(task?{stateDirectory:task.stateDirectory}:{}),fixtureOci:fixture&&process.argv.includes("--fixture-oci"),fixtureEffectCrash:fixture&&process.argv.includes("--fixture-effect-crash"),recover:true});runtimes.set(key,pending);void pending.catch(()=>{if(runtimes.get(key)===pending)runtimes.delete(key);});}
  return {...(await pending).context,...(task?{task:taskView(task)}:{})};
 };
 const runtime=async(key:unknown)=>{if(typeof key!=="string"||!runtimes.has(key))throw new Error("PROJECT_NOT_OPEN");return runtimes.get(key)!;};
 const index=path.join(buildDirectory,"index.html"),url=pathToFileURL(index).href;
 const window=new BrowserWindow({width:1120,height:760,minWidth:720,minHeight:520,show:false,backgroundColor:"#101315",title:"Zhivex Harness",webPreferences:{preload:path.join(buildDirectory,"preload.cjs"),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 mainWindow=window;
 const fixtureCloseChoices=fixture?(argument("--fixture-close-choices")??"").split(","):[];
 requestExit=()=>{
  if(closing||exitApproved)return;closing=true;
  void(async()=>{
   await Promise.allSettled([...taskOperations]);
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
 ipcMain.handle("harness:projects",event=>{validateSender(event);const managed=new Set(tasks.list().map(task=>task.workspace));return registry.list().filter(project=>!managed.has(project.workspace));});
 ipcMain.handle("harness:tasks",(event,key:unknown)=>{validateSender(event);if(typeof key!=="string")throw new Error("INVALID_PROJECT");return tasks.list(sourceProject(key).key).map(taskView);});
 ipcMain.handle("harness:create-task",(event,value:unknown)=>{
  validateSender(event);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="input,projectKey")throw new Error("INVALID_TASK");
  const payload=value as {projectKey:unknown;input:unknown};if(typeof payload.projectKey!=="string")throw new Error("INVALID_PROJECT");
  return trackTask(tasks.create(sourceProject(payload.projectKey),payload.input).then(taskView));
 });
 ipcMain.handle("harness:open-task",async(event,id:unknown)=>{validateSender(event);if(typeof id!=="string")throw new Error("INVALID_TASK");const task=tasks.get(id);if(task.status!=="ready"||removing.has(task.workspace))throw new Error("TASK_NOT_READY");const project=await registry.select(task.workspace);return connect(project.key);});
 const removalTickets=new Map<string,string>();
 ipcMain.handle("harness:review-task-removal",async(event,id:unknown)=>{validateSender(event);if(typeof id!=="string")throw new Error("INVALID_TASK");const review=await tasks.reviewRemoval(id);removalTickets.set(review.ticketId,id);while(removalTickets.size>128)removalTickets.delete(removalTickets.keys().next().value!);return{...review,task:taskView(review.task)};});
 ipcMain.handle("harness:remove-task",(event,ticketId:unknown)=>{
  validateSender(event);if(typeof ticketId!=="string"||!removalTickets.has(ticketId))throw new Error("TASK_REVIEW_REQUIRED");const id=removalTickets.get(ticketId)!;removalTickets.delete(ticketId);
  return trackTask((async()=>{
   const task=tasks.get(id);if(removing.has(task.workspace))throw new Error("TASK_BUSY");removing.add(task.workspace);
   const project=registry.list().find(project=>project.workspace===task.workspace);const pending=project?runtimes.get(project.key):undefined;let host:ProjectRuntime|undefined;
   try{
    if(pending){host=await pending;if(await host.controlClose("pause"))throw new Error("TASK_BUSY");await host.close();runtimes.delete(project!.key);}
    return taskView(await tasks.remove(ticketId));
   }finally{if(host?.isAlive())await host.controlClose("resume").catch(()=>{});removing.delete(task.workspace);}
  })());
 });
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
 if(fixture&&reportDirectory){await mkdir(reportDirectory,{recursive:true});const restartPhase=argument("--fixture-restart-phase");if(restartPhase?.startsWith("tasks-"))await verifyDesktopWorktreesSmoke(window,runtimes,reportDirectory,restartPhase);else if(restartPhase?.startsWith("effect-"))await verifyDesktopEffectCrashSmoke(window,runtimes,reportDirectory,restartPhase);else if(restartPhase)await verifyDesktopRestartSmoke(window,runtimes,reportDirectory,restartPhase,argument("--fixture-cli"));else{await (process.argv.includes("--fixture-oci")?verifyDesktopOciSmoke:verifyDesktopSmoke)(window,runtimes,reportDirectory);app.quit();}}
}).catch(async(error)=>{if(fixture)console.error(error);if(reportDirectory)await writeFile(path.join(reportDirectory,"failure.json"),JSON.stringify({code:"DESKTOP_VERIFICATION_FAILED"})).catch(()=>{});process.stderr.write("Desktop could not start or verify. Check workspace access and runtime ownership.\n");app.exit(1);});
app.on("window-all-closed",()=>app.quit());
