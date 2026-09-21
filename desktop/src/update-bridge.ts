import type {IpcRenderer} from "electron";
import type {DesktopUpdateCheckState} from "./update-feed.js";
declare module "./bridge.js" {interface DesktopBridge {updateStatus(): Promise<DesktopUpdateCheckState>; checkUpdates(): Promise<DesktopUpdateCheckState>}}
export function updateBridge(ipc: IpcRenderer) {
 return {updateStatus: () => ipc.invoke("harness:update-status"), checkUpdates: () => ipc.invoke("harness:check-updates")};
}
