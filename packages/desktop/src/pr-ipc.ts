import {ipcMain,shell,type IpcMainInvokeEvent} from "electron";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {openPullRequestDelivery} from "./pr-delivery.js";
import {openGitHubPullRequestTransport} from "./github-pr-transport.js";
import type {openGitHubGitTransport} from "./github-git-transport.js";
import {hostSensitiveValues} from "./redaction.js";
interface Dependencies {
 payload(event:IpcMainInvokeEvent,value:unknown,fields:string[]):Record<string,unknown>&{projectKey:string};
 remote(key:string):Promise<{transport:Awaited<ReturnType<typeof openGitHubGitTransport>>}>;
 mutate<T>(key:string,operation:()=>Promise<T>):Promise<T>;
 track<T>(operation:Promise<T>):Promise<T>;
 directory:string;dropResponse:boolean;fixtureDirectory?:string;
}
export function registerPullRequestIpc(deps:Dependencies){
 const managers=new Map<string,Promise<Awaited<ReturnType<typeof openPullRequestDelivery>>>>();let dropped=false;
 const manager=async(key:string)=>{const {transport}=await deps.remote(key);let pending=managers.get(key);if(!pending){pending=openPullRequestDelivery(path.join(deps.directory,key),openGitHubPullRequestTransport(transport),hostSensitiveValues(process.env));managers.set(key,pending);void pending.catch(()=>managers.delete(key));}return pending;};
 ipcMain.handle("harness:review-pr",(event,value:unknown)=>{const p=deps.payload(event,value,["projectKey","input"]);return deps.track((async()=>(await manager(p.projectKey)).review(p.input))());});
 ipcMain.handle("harness:create-pr",(event,value:unknown)=>{const p=deps.payload(event,value,["projectKey","ticketId"]);if(typeof p.ticketId!=="string")throw new Error("INVALID_PR_REQUEST");const id=p.ticketId;return deps.track(deps.mutate(p.projectKey,async()=>{const result=await(await manager(p.projectKey)).create(id);if(deps.dropResponse&&!dropped&&result.status==="completed"){dropped=true;throw new Error("PR_RESPONSE_LOST");}return result;}));});
 ipcMain.handle("harness:reconcile-pr",(event,value:unknown)=>{const p=deps.payload(event,value,["projectKey","operationId"]);if(typeof p.operationId!=="string")throw new Error("INVALID_PR_REQUEST");const id=p.operationId;return deps.track((async()=>(await manager(p.projectKey)).reconcile(id))());});
 ipcMain.handle("harness:open-pr",(event,value:unknown)=>{const p=deps.payload(event,value,["projectKey","operationId"]);if(typeof p.operationId!=="string")throw new Error("INVALID_PR_REQUEST");const id=p.operationId;return deps.track((async()=>{const result=await(await manager(p.projectKey)).reconcile(id);if(!("result" in result)||!result.result||!["completed","needs-review"].includes(result.status))throw new Error("PR_NOT_CONFIRMED");const url=result.result.url,repository=result.destination.url.replace(/\.git$/,"");if(url!==`${repository}/pull/${result.result.number}`)throw new Error("PR_URL_INVALID");if(deps.fixtureDirectory)await writeFile(path.join(deps.fixtureDirectory,"opened-pr.json"),JSON.stringify({operationId:id,url}));else await shell.openExternal(url);})());});
}
