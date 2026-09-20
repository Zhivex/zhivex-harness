import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.js";
const bridge:DesktopBridge=Object.freeze({
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
