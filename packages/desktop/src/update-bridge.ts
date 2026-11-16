import type {IpcRenderer} from "electron";
import type {DesktopUpdateState} from "./update-session.js";
declare module "./bridge.js" {interface DesktopBridge {updateStatus(): Promise<DesktopUpdateState>; checkUpdates(): Promise<DesktopUpdateState>; downloadUpdate(): Promise<DesktopUpdateState>; installUpdate(): Promise<DesktopUpdateState>}}
export function updateBridge(ipc: IpcRenderer) {
 return {installUpdate: () => ipc.invoke("harness:install-update"), downloadUpdate: () => ipc.invoke("harness:download-update"), updateStatus: () => ipc.invoke("harness:update-status"), checkUpdates: () => ipc.invoke("harness:check-updates")};
}
