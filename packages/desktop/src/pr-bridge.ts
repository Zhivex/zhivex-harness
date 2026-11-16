import type {IpcRenderer} from "electron";
import type {PullRequestInput,PullRequestReview,PullRequestOperation} from "./pr-delivery.js";
declare module "./bridge.js" {
 interface DesktopBridge {
  reviewPr(projectKey:string,input:PullRequestInput):Promise<PullRequestReview>;
  createPr(projectKey:string,ticketId:string):Promise<PullRequestOperation>;
  reconcilePr(projectKey:string,operationId:string):Promise<PullRequestOperation|{id:string;status:"not-accepted"}>;
  openPr(projectKey:string,operationId:string):Promise<void>;
 }
}
export const pullRequestBridge=(ipc:IpcRenderer)=>({
 reviewPr:(projectKey:string,input:PullRequestInput)=>ipc.invoke("harness:review-pr",{projectKey,input}),
 createPr:(projectKey:string,ticketId:string)=>ipc.invoke("harness:create-pr",{projectKey,ticketId}),
 reconcilePr:(projectKey:string,operationId:string)=>ipc.invoke("harness:reconcile-pr",{projectKey,operationId}),
 openPr:(projectKey:string,operationId:string)=>ipc.invoke("harness:open-pr",{projectKey,operationId})
});
