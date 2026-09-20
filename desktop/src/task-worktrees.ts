import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,lstat,realpath,open,rename,unlink} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {z} from "zod";
import type {DesktopProject} from "./bridge.js";
const execute=promisify(execFile);
const env={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_PAGER:"cat"};
const protections=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.autocrlf=false","-c","core.sparseCheckout=false","-c","submodule.recurse=false","-c","protocol.file.allow=never","-c","protocol.ext.allow=never"];
async function git(workspace:string,args:string[],additionalFilterWorkspaces:string[]=[]){
 // Even status can execute clean filters. Read names only and override every
 // configured filter command before running repository operations.
 const keys=(await Promise.all([...new Set([workspace,...additionalFilterWorkspaces])].map(directory=>execute("git",["-C",directory,...protections,"config","--null","--name-only","--get-regexp","^filter\\..*\\.(clean|smudge|process|required)$"],{env,timeout:5000,maxBuffer:65536}).then(result=>result.stdout.split("\0").filter(Boolean),error=>{if(error.code===1)return [];throw new Error("WORKTREE_CONFIG_UNAVAILABLE");})))).flat();
 const filters=keys.flatMap(key=>{if(!/^filter\.[A-Za-z0-9._/-]+\.(clean|smudge|process|required)$/.test(key))throw new Error("WORKTREE_FILTER_UNSUPPORTED");return["-c",`${key}=${key.endsWith(".required")?"false":""}`];});
 return (await execute("git",["-C",workspace,...protections,...filters,...args],{env,timeout:15000,maxBuffer:1024*1024})).stdout;
}
const taskSchema=z.object({id:z.string().uuid(),sourceProjectKey:z.string().regex(/^project_[a-f0-9]{32}$/),sourceWorkspace:z.string().min(1),workspace:z.string().min(1),stateDirectory:z.string().min(1),title:z.string().min(1).max(120),branch:z.string().min(1).max(128),baseCommit:z.string().regex(/^[a-f0-9]{40,64}$/),integrationRef:z.string().min(1).max(256),status:z.enum(["creating","ready","needs-attention","removed"]),createdAt:z.number().int(),error:z.string().optional()}).strict();
export type ManagedTask=z.infer<typeof taskSchema>;
export interface TaskRemovalReview {ticketId:string;task:ManagedTask;head:string;integrationCommit:string;changedPaths:string[];unmergedCommits:number;locked:boolean;canRemove:boolean;expiresAt:number}
const indexSchema=z.object({schemaVersion:z.literal(1),tasks:z.array(taskSchema).max(500)}).strict();
export const taskCreationSchema=z.object({title:z.string().trim().min(1).max(120),branch:z.string().regex(/^feat\/[A-Za-z0-9][A-Za-z0-9._/-]{0,110}$/).optional(),initialState:z.literal("committed-head")}).strict();
const fingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const projectIdentity=(workspace:string)=>`project_${createHash("sha256").update(workspace).digest("hex").slice(0,32)}`;

/** Single desktop-owner registry. Git directories and task records are never guessed. */
export async function openTaskWorktrees(directory:string){
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error("TASK_DIRECTORY_UNSAFE");
 const root=await realpath(directory),filename=path.join(root,"tasks.json");let tasks:ManagedTask[]=[];
 try{const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1024*1024)throw new Error("TASK_INDEX_UNSAFE");tasks=indexSchema.parse(JSON.parse(await handle.readFile("utf8"))).tasks;}finally{await handle.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 for(const task of tasks)if(task.workspace!==path.join(root,task.id,"checkout")||task.stateDirectory!==path.join(root,task.id,"state")||!path.isAbsolute(task.sourceWorkspace)||task.sourceProjectKey!==projectIdentity(task.sourceWorkspace))throw new Error("TASK_IDENTITY_INVALID");
 if(new Set(tasks.map(task=>task.id)).size!==tasks.length)throw new Error("TASK_IDENTITY_INVALID");
 let writes=Promise.resolve();
 const serial=<T>(operation:()=>Promise<T>)=>{const result=writes.then(operation);writes=result.then(()=>{},()=>{});return result;};
 const persist=async()=>{const contents=JSON.stringify({schemaVersion:1,tasks});if(Buffer.byteLength(contents)>1024*1024)throw new Error("TASK_INDEX_LIMIT");const temporary=filename+`.${randomUUID()}.tmp`,handle=await open(temporary,"wx",0o600);try{await handle.writeFile(contents);await handle.sync();}finally{await handle.close();}try{await rename(temporary,filename);}finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}};
 // A new desktop owner must not pretend a crashed creation is still progressing.
 if(tasks.some(task=>task.status==="creating")){tasks=tasks.map(task=>task.status==="creating"?{...task,status:"needs-attention",error:"TASK_CREATION_INTERRUPTED"}:task);await persist();}
 const get=(id:string)=>{const task=tasks.find(task=>task.id===id);if(!task)throw new Error("TASK_NOT_FOUND");return task;};
 const assertIdentity=async(task:ManagedTask)=>{
  if(task.status!=="ready")throw new Error("TASK_NOT_READY");
  if(await realpath(task.workspace)!==task.workspace)throw new Error("TASK_WORKSPACE_CHANGED");
  const top=await realpath((await git(task.workspace,["rev-parse","--show-toplevel"])).trim());
  const branch=(await git(task.workspace,["symbolic-ref","HEAD"])).trim();
  const common=await realpath((await git(task.workspace,["rev-parse","--path-format=absolute","--git-common-dir"])).trim());
  const sourceCommon=await realpath((await git(task.sourceWorkspace,["rev-parse","--path-format=absolute","--git-common-dir"])).trim());
  if(top!==task.workspace||branch!==`refs/heads/${task.branch}`||common!==sourceCommon)throw new Error("TASK_WORKSPACE_CHANGED");
 };
 const inspect=async(task:ManagedTask)=>{
  await assertIdentity(task);
  const head=(await git(task.workspace,["rev-parse","--verify","HEAD"])).trim();
  const integrationCommit=(await git(task.sourceWorkspace,["rev-parse","--verify",`${task.integrationRef}^{commit}`])).trim();
  const registered=(await git(task.sourceWorkspace,["worktree","list","--porcelain","-z"])).split("\0\0").map(entry=>entry.split("\0")).find(fields=>fields.includes(`worktree ${task.workspace}`));
  if(!registered)throw new Error("TASK_NOT_REGISTERED");const locked=registered.some(field=>field==="locked"||field.startsWith("locked "));
  const status=await git(task.workspace,["status","--porcelain=v1","-z","--untracked-files=all","--ignored=matching"]);
  const entries=status.split("\0").filter(Boolean),changedPaths:string[]=[];
  for(let i=0;i<entries.length;i++){const entry=entries[i]!;changedPaths.push(entry.slice(3));if(/[RC]/.test(entry.slice(0,2))&&entries[i+1])changedPaths.push(entries[++i]!);}
  const unmergedCommits=Number((await git(task.workspace,["rev-list","--count",`${integrationCommit}..${head}`])).trim());
  if(!Number.isSafeInteger(unmergedCommits)||unmergedCommits<0)throw new Error("TASK_INSPECTION_FAILED");
  return{head,integrationCommit,changedPaths,unmergedCommits,locked,canRemove:!locked&&changedPaths.length===0&&unmergedCommits===0};
 };
 const tickets=new Map<string,{id:string;fingerprint:string;expiresAt:number}>();
 return{
  list:(sourceProjectKey?:string)=>structuredClone(tasks.filter(task=>sourceProjectKey===undefined||task.sourceProjectKey===sourceProjectKey)),
  get:(id:string)=>structuredClone(get(id)),
  async create(project:DesktopProject,input:unknown){return serial(async()=>{
   const parsed=taskCreationSchema.parse(input);if(tasks.length>=500)throw new Error("TASK_INDEX_LIMIT");
   const sourceWorkspace=await realpath(project.workspace);if(sourceWorkspace!==(await realpath((await git(sourceWorkspace,["rev-parse","--show-toplevel"])).trim())))throw new Error("TASK_SOURCE_CHANGED");
   if(project.key!==projectIdentity(sourceWorkspace))throw new Error("TASK_SOURCE_CHANGED");
   const baseCommit=(await git(sourceWorkspace,["rev-parse","--verify","HEAD^{commit}"])).trim();
   const integrationRef=await git(sourceWorkspace,["symbolic-ref","HEAD"]).then(value=>value.trim(),()=>baseCommit);
   const id=randomUUID(),branch=parsed.branch??`feat/harness-${id}`;
   await git(sourceWorkspace,["check-ref-format",`refs/heads/${branch}`]);
   const task=taskSchema.parse({id,sourceProjectKey:project.key,sourceWorkspace,workspace:path.join(root,id,"checkout"),stateDirectory:path.join(root,id,"state"),title:parsed.title,branch,baseCommit,integrationRef,status:"creating",createdAt:Date.now()});
   tasks.push(task);await persist();
   try{
    await mkdir(path.join(root,id),{mode:0o700});
    await git(sourceWorkspace,["worktree","add","--no-checkout","-b",branch,task.workspace,baseCommit]);
    if(await realpath((await git(task.workspace,["rev-parse","--show-toplevel"])).trim())!==task.workspace)throw new Error("TASK_WORKSPACE_CHANGED");
    // Populate the new index and files without --force: never overwrite a file
    // that another actor placed here, and never touch the original checkout.
    await git(task.workspace,["read-tree",baseCommit]);await git(task.workspace,["checkout-index","--all"]);
    task.status="ready";await persist();return structuredClone(task);
   }catch{task.status="needs-attention";task.error="TASK_CREATION_INCOMPLETE";await persist();throw new Error("TASK_CREATION_INCOMPLETE");}
  });},
  async inspect(id:string){return{task:structuredClone(get(id)),...await inspect(get(id))};},
  async reviewRemoval(id:string):Promise<TaskRemovalReview>{return serial(async()=>{
   const task=get(id),snapshot=await inspect(task),ticketId=randomUUID(),expiresAt=Date.now()+5*60_000;
   tickets.set(ticketId,{id,fingerprint:fingerprint(snapshot),expiresAt});while(tickets.size>128)tickets.delete(tickets.keys().next().value!);
   return{ticketId,task:structuredClone(task),...snapshot,expiresAt};
  });},
  async remove(ticketId:string){return serial(async()=>{
   const ticket=tickets.get(ticketId);if(!ticket)throw new Error("TASK_REVIEW_REQUIRED");tickets.delete(ticketId);if(ticket.expiresAt<=Date.now())throw new Error("TASK_REVIEW_EXPIRED");
   const task=get(ticket.id),current=await inspect(task);if(fingerprint(current)!==ticket.fingerprint)throw new Error("TASK_REVIEW_CHANGED");if(current.locked)throw new Error("TASK_LOCKED");if(!current.canRemove)throw new Error("TASK_HAS_UNINTEGRATED_CHANGES");
   // Git rechecks cleanliness and locks; no --force and no branch deletion.
   await git(task.sourceWorkspace,["worktree","remove",task.workspace],[task.workspace]);task.status="removed";await persist();return structuredClone(task);
  });}
 };
}
