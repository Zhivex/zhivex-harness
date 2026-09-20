import type {IpcRenderer} from "electron";
import type {CredentialStatus,CredentialProbe} from "./credential-store.js";
declare module "./bridge.js" {interface DesktopBridge {credentialStatus():Promise<CredentialStatus>;configureCredential():Promise<CredentialStatus>;deleteCredential():Promise<CredentialStatus>;probeCredential():Promise<CredentialProbe>}}
export function credentialBridge(ipc:IpcRenderer){return {credentialStatus:()=>ipc.invoke("harness:credential-status"),configureCredential:()=>ipc.invoke("harness:credential-configure"),deleteCredential:()=>ipc.invoke("harness:credential-delete"),probeCredential:()=>ipc.invoke("harness:credential-probe")};}
