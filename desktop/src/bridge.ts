import type { HarnessClientResponse } from "../../src/client-contract.js";
import type { HarnessActivityPage } from "../../src/service-events.js";
export interface DesktopProject {key:string;workspace:string;name:string;lastOpenedAt:number}
export interface DesktopContext {project:DesktopProject;projectId:string;runtimePid:number;runtimeNode:string;fixture:boolean}
export interface DesktopBridge {
 review(projectKey:string,sessionId:string,runId:string):Promise<import("./approval-review.js").ApprovalReview>;
 projects():Promise<DesktopProject[]>;
 chooseProject():Promise<DesktopContext|null>;
 openProject(projectKey:string):Promise<DesktopContext>;
 initialProject():Promise<DesktopContext|null>;
 command(projectKey:string,command:Record<string,unknown>):Promise<HarnessClientResponse>;
 events(projectKey:string,sessionId:string,after:number):Promise<HarnessActivityPage>;
}
declare global {interface Window {harness:DesktopBridge}}
