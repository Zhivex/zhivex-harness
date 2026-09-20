import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.js";
const bridge:DesktopBridge=Object.freeze({
 projects:()=>ipcRenderer.invoke("harness:projects"),
 chooseProject:()=>ipcRenderer.invoke("harness:choose-project"),
 openProject:(projectKey:string)=>ipcRenderer.invoke("harness:open-project",projectKey),
 initialProject:()=>ipcRenderer.invoke("harness:initial-project"),
 command:(projectKey:string,command:Record<string,unknown>)=>ipcRenderer.invoke("harness:command",{projectKey,command}),
 events:(projectKey:string,sessionId:string,after:number)=>ipcRenderer.invoke("harness:events",{projectKey,sessionId,after})
});
contextBridge.exposeInMainWorld("harness",bridge);
