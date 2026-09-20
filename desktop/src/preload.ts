import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.js";
const bridge: DesktopBridge = Object.freeze({
  context: () => ipcRenderer.invoke("harness:context"),
  command: (command: Record<string,unknown>) => ipcRenderer.invoke("harness:command", command),
  events: (sessionId: string, after: number) => ipcRenderer.invoke("harness:events", {sessionId, after})
});
contextBridge.exposeInMainWorld("harness", bridge);
