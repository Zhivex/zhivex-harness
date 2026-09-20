import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.js";
const bridge:DesktopBridge=Object.freeze({
 tasks:(projectKey:string)=>ipcRenderer.invoke("harness:tasks",projectKey),
 createTask:(projectKey:string,input:unknown)=>ipcRenderer.invoke("harness:create-task",{projectKey,input}),
 openTask:(taskId:string)=>ipcRenderer.invoke("harness:open-task",taskId),
 reviewTaskRemoval:(taskId:string)=>ipcRenderer.invoke("harness:review-task-removal",taskId),
 removeTask:(ticketId:string)=>ipcRenderer.invoke("harness:remove-task",ticketId),
 resolveReview:(projectKey:string,ticketId:string,approve:boolean)=>ipcRenderer.invoke("harness:resolve-review",{projectKey,ticketId,approve}),
 review:(projectKey:string,sessionId:string,runId:string)=>ipcRenderer.invoke("harness:review",{projectKey,sessionId,runId}),
 projects:()=>ipcRenderer.invoke("harness:projects"),
 chooseProject:()=>ipcRenderer.invoke("harness:choose-project"),
 openProject:(projectKey:string)=>ipcRenderer.invoke("harness:open-project",projectKey),
 initialProject:()=>ipcRenderer.invoke("harness:initial-project"),
 command:(projectKey:string,command:Record<string,unknown>)=>ipcRenderer.invoke("harness:command",{projectKey,command}),
 events:(projectKey:string,sessionId:string,after:number)=>ipcRenderer.invoke("harness:events",{projectKey,sessionId,after})
});
contextBridge.exposeInMainWorld("harness",bridge);
