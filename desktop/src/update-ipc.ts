import type {IpcMain, IpcMainInvokeEvent} from "electron";
import type {createDesktopUpdateFeed} from "./update-feed.js";
export function registerDesktopUpdateIpc(ipc: Pick<IpcMain, "handle">, validate: (event: IpcMainInvokeEvent) => void, feed: ReturnType<typeof createDesktopUpdateFeed>) {
 const guard = (event: IpcMainInvokeEvent, args: unknown[]) => {validate(event); if (args.length) throw new Error("INVALID_UPDATE_REQUEST");};
 ipc.handle("harness:update-status", (event, ...args: unknown[]) => {guard(event, args); return feed.state();});
 ipc.handle("harness:check-updates", (event, ...args: unknown[]) => {guard(event, args); return feed.check();});
}
