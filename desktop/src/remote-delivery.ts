import {randomUUID,createHash} from "node:crypto";
import {mkdir,lstat,open,rename,unlink,realpath} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createRedactionPolicy} from "@zhivex-ai/agents";
const oid=z.string().regex(/^[a-f0-9]{40,64}$/);
const branch=z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/).refine(value=>!value.includes("..")&&!value.endsWith("/")&&!value.endsWith(".lock"));
export const pushDestinationSchema=z.object({remote:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/),url:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/).refine(value=>new URL(value).href===value),ref:branch,baseRef:branch}).strict();
const fileSchema=z.object({path:z.string().min(1).max(512),before:z.string().max(256*1024),after:z.string().max(256*1024),beforeMode:z.enum(["000000","100644","100755"]),afterMode:z.enum(["000000","100644","100755"]),parent:oid}).strict();
const snapshotSchema=z.object({branch,head:oid,destination:pushDestinationSchema,remoteHead:oid.nullable(),baseHead:oid,fastForward:z.boolean(),stagedPaths:z.array(z.string()).max(100),commits:z.array(z.object({id:oid,message:z.string().max(16000),files:z.array(fileSchema).max(100)}).strict()).max(100)}).strict();
export type PushSnapshot=z.infer<typeof snapshotSchema>;
export type PushDestination=z.infer<typeof pushDestinationSchema>;
export interface PushReview extends PushSnapshot {ticketId:string;expiresAt:number}
const operationSchema=z.object({id:z.string().uuid(),head:oid,destination:pushDestinationSchema,previousHead:oid.nullable(),status:z.enum(["prepared","completed"])}).strict();
export type PushOperation=z.infer<typeof operationSchema>;
/** Implementations belong to the host, never the renderer or a model. */
export interface RemoteTransport {
 inspect(destination:PushDestination):Promise<PushSnapshot>;
 readHead(destination:PushDestination):Promise<string|null>;
 /** Must use ordinary non-forced push of this exact object to this single ref. */
 push(head:string,destination:PushDestination):Promise<void>;
}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Durable admission and reconciliation for one host/project, with no automatic retry. */
export async function openRemoteDelivery(directory:string,transport:RemoteTransport,sensitiveValues:readonly string[]=[]){
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error("REMOTE_STATE_UNSAFE");const root=await realpath(directory);
 const policy=createRedactionPolicy({includeEmails:false});
 const sensitive=(value:string)=>policy.redactText(value)!==value||/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/i.test(value)||sensitiveValues.some(secret=>secret.length>0&&value.includes(secret));
 const inspect=async(destination:PushDestination)=>{
  const state=snapshotSchema.parse(await transport.inspect(destination));if(JSON.stringify(state.destination)!==JSON.stringify(destination))throw new Error("REMOTE_DESTINATION_CHANGED");
  if(!state.fastForward)throw new Error("REMOTE_DIVERGED");if(state.stagedPaths.length)throw new Error("REMOTE_STAGED_CHANGES");if(state.remoteHead===state.head)throw new Error("REMOTE_ALREADY_CURRENT");
  if(state.commits.at(-1)?.id!==state.head||new Set(state.commits.map(commit=>commit.id)).size!==state.commits.length)throw new Error("REMOTE_HISTORY_INCOMPLETE");
  if(Buffer.byteLength(JSON.stringify(state))>2*1024*1024)throw new Error("REMOTE_REVIEW_TOO_LARGE");
  if(sensitive(JSON.stringify(state)))throw new Error("REMOTE_SECRET_DETECTED");
  for(const commit of state.commits)for(const file of commit.files)if(file.path.split("/").some(part=>!part||part===".."||part==="."||part===".git"||part===".zhivex-harness")||/[\x00-\x1f\x7f\\]/.test(file.path)||/(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(file.path))throw new Error("REMOTE_PATH_BLOCKED");
  return state;
 };
 const tickets=new Map<string,{snapshot:PushSnapshot;expiresAt:number}>();let queue=Promise.resolve();const serial=<T>(fn:()=>Promise<T>)=>{const result=queue.then(fn);queue=result.then(()=>{},()=>{});return result;};
 const persist=async(operation:PushOperation)=>{const target=path.join(root,`${operation.id}.json`),temporary=target+`.${randomUUID()}.tmp`,file=await open(temporary,"wx",0o600);try{await file.writeFile(JSON.stringify(operation));await file.sync();}finally{await file.close();}try{await rename(temporary,target);const directory=await open(root,"r");try{await directory.sync();}finally{await directory.close();}}finally{await unlink(temporary).catch(()=>{});}};
 const read=async(id:string)=>{z.string().uuid().parse(id);const file=await open(path.join(root,`${id}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>16384)throw new Error("REMOTE_STATE_UNSAFE");const operation=operationSchema.parse(JSON.parse(await file.readFile("utf8")));if(operation.id!==id)throw new Error("REMOTE_OPERATION_CHANGED");return operation;}finally{await file.close();}};
 const reconcile=async(id:string)=>{const operation=await read(id);if(operation.status==="completed")return operation;const current=await transport.readHead(operation.destination);if(current!==operation.head)throw new Error("REMOTE_OUTCOME_UNCONFIRMED");operation.status="completed";await persist(operation);return operation;};
 return{
  reviewPush:(input:unknown):Promise<PushReview>=>serial(async()=>{const destination=pushDestinationSchema.parse(input),snapshot=await inspect(destination),ticketId=randomUUID(),expiresAt=Date.now()+5*60000;tickets.set(ticketId,{snapshot,expiresAt});while(tickets.size>128)tickets.delete(tickets.keys().next().value!);return{...structuredClone(snapshot),ticketId,expiresAt};}),
  push:(ticketId:string):Promise<PushOperation>=>serial(async()=>{
   try{return await reconcile(ticketId);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   const ticket=tickets.get(ticketId);if(!ticket)throw new Error("REMOTE_REVIEW_REQUIRED");tickets.delete(ticketId);if(ticket.expiresAt<=Date.now())throw new Error("REMOTE_REVIEW_EXPIRED");
   const current=await inspect(ticket.snapshot.destination);if(hash(current)!==hash(ticket.snapshot))throw new Error("REMOTE_REVIEW_CHANGED");
   const operation:PushOperation={id:ticketId,head:current.head,destination:current.destination,previousHead:current.remoteHead,status:"prepared"};await persist(operation);
   try{await transport.push(current.head,current.destination);}catch{/* A lost response can follow a successful remote mutation. Only read to reconcile. */}
   return reconcile(ticketId);
  }),
  reconcile:(id:string):Promise<PushOperation|{id:string;status:"not-accepted"}>=>serial(async()=>{try{return await reconcile(id);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{id,status:"not-accepted"};throw error;}})
 };
}
