import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash,randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {open,mkdir,lstat,realpath,rename,unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {createRedactionPolicy} from "@zhivex-ai/agents";
const execute=promisify(execFile),digest=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const oid=z.string().regex(/^[a-f0-9]{40,64}$/);
const inputSchema=z.object({paths:z.array(z.string().min(1).max(512)).min(1).max(100),message:z.string().trim().min(1).max(4000)}).strict();
export interface CommitFile {path:string;before:string;after:string;beforeMode:string;afterMode:string}
export interface CommitReview {ticketId:string;branch:string;head:string;tree:string;message:string;files:CommitFile[];author:string;committer:string;destination:"local";expiresAt:number}
const operationSchema=z.object({id:z.string().uuid(),workspace:z.string(),branch:z.string(),head:oid,tree:oid,commit:oid,status:z.enum(["prepared","completed"])}).strict();
export type CommitOperation=z.infer<typeof operationSchema>;

/** Host-only, single desktop owner. No staging, hooks, signing, push or shell evaluation. */
export async function openGitDelivery(workspace:string,directory:string,sensitiveValues:readonly string[]=[]){
 const canonical=await realpath(workspace);
 const environment={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_PAGER:"cat"};
 const git=async(args:string[],extra:Record<string,string>={})=>{try{return(await execute("git",["-C",canonical,"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","commit.gpgsign=false",...args],{env:{...environment,...extra},encoding:"buffer",timeout:15000,maxBuffer:2*1024*1024})).stdout;}catch{throw new Error("GIT_DELIVERY_FAILED");}};
 const text=async(args:string[])=>new TextDecoder("utf-8",{fatal:true}).decode(await git(args)).trim();
 if(await realpath(await text(["rev-parse","--show-toplevel"]))!==canonical)throw new Error("GIT_WORKSPACE_CHANGED");
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error("GIT_DELIVERY_STATE_UNSAFE");const root=await realpath(directory);
 const safeRead=async(filename:string,limit:number)=>{const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.size>limit)throw new Error("GIT_DELIVERY_FILE_UNSAFE");return await handle.readFile();}finally{await handle.close();}};
 const index=await text(["rev-parse","--path-format=absolute","--git-path","index"]);
 const policy=createRedactionPolicy({includeEmails:false});
 const checkText=(value:string)=>{if(policy.redactText(value)!==value||/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/i.test(value)||sensitiveValues.some(secret=>secret.length>0&&value.includes(secret)))throw new Error("GIT_DELIVERY_SECRET_DETECTED");};
 const checkPath=(value:string)=>{if(path.posix.isAbsolute(value)||value.split("/").some(part=>!part||part===".."||part==="."||part===".git"||part===".zhivex-harness")||/[\x00-\x1f\x7f\\]/.test(value)||/(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(value))throw new Error("GIT_DELIVERY_PATH_BLOCKED");checkText(value);};
 const identity=async(kind:"AUTHOR"|"COMMITTER")=>{// Identity discovery honors the user's global Git identity, but only runs
  // git var with a bounded environment; it never executes hooks or signing.
  const {GIT_CONFIG_GLOBAL:_ignored,...identityEnvironment}=environment;
  let value:string;try{value=(await execute("git",["-C",canonical,"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","user.useConfigOnly=true","var",`GIT_${kind}_IDENT`],{env:identityEnvironment,encoding:"utf8",timeout:5000,maxBuffer:8192})).stdout.trim();}catch{throw new Error("GIT_IDENTITY_REQUIRED");}const match=/^(.+) <([^<>\n]+)> (\d+) ([+-]\d{4})$/.exec(value);if(!match)throw new Error("GIT_IDENTITY_REQUIRED");checkText(`${match[1]} <${match[2]}>`);return{name:match[1]!,email:match[2]!,date:`${match[3]} ${match[4]}`};};
 const snapshot=async()=>{
  if((await git(["ls-files","--unmerged","-z"])).length)throw new Error("GIT_CONFLICTS");
  for(const name of ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge","rebase-apply"]){const target=await text(["rev-parse","--path-format=absolute","--git-path",name]);try{await lstat(target);throw new Error("GIT_OPERATION_IN_PROGRESS");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  const branch=await text(["symbolic-ref","HEAD"]);if(!branch.startsWith("refs/heads/"))throw new Error("GIT_BRANCH_REQUIRED");checkText(branch);
  const head=oid.parse(await text(["rev-parse","--verify","HEAD^{commit}"]));
  const tree=oid.parse(await text(["write-tree"]));const indexDigest=digest(await safeRead(index,16*1024*1024));
  const entries=(await git(["diff-tree","--no-commit-id","--raw","-z","--no-renames",head,tree])).toString("utf8").split("\0").filter(Boolean);
  const files:CommitFile[]=[];let bytes=0;
  for(let i=0;i<entries.length;i+=2){const match=/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) [AMD]$/.exec(entries[i]!);if(!match||!entries[i+1])throw new Error("GIT_CHANGE_UNSUPPORTED");const filename=entries[i+1]!;checkPath(filename);
   if(![match[1],match[2]].every(mode=>["000000","100644","100755"].includes(mode!)))throw new Error("GIT_MODE_UNSUPPORTED");
   const blob=async(id:string)=>{if(/^0+$/.test(id))return "";const buffer=await git(["cat-file","blob",id]);bytes+=buffer.length;if(buffer.length>256*1024||bytes>1024*1024||buffer.includes(0))throw new Error("GIT_PREVIEW_INCOMPLETE");const value=new TextDecoder("utf-8",{fatal:true}).decode(buffer);checkText(value);return value;};
   files.push({path:filename,before:await blob(match[3]!),after:await blob(match[4]!),beforeMode:match[1]!,afterMode:match[2]!});if(files.length>100)throw new Error("GIT_PREVIEW_INCOMPLETE");
  }
  if(!files.length)throw new Error("GIT_NOTHING_STAGED");return{branch,head,tree,indexDigest,files};
 };
 const tickets=new Map<string,{review:CommitReview;indexDigest:string;author:Awaited<ReturnType<typeof identity>>;committer:Awaited<ReturnType<typeof identity>>}>();
 const persist=async(operation:CommitOperation)=>{const destination=path.join(root,`${operation.id}.json`),temporary=destination+`.${randomUUID()}.tmp`,handle=await open(temporary,"wx",0o600);try{await handle.writeFile(JSON.stringify(operation));await handle.sync();}finally{await handle.close();}try{await rename(temporary,destination);const directoryHandle=await open(root,"r");try{await directoryHandle.sync();}finally{await directoryHandle.close();}}finally{await unlink(temporary).catch(()=>{});}};
 const readOperation=async(id:string)=>{z.string().uuid().parse(id);const operation=operationSchema.parse(JSON.parse((await safeRead(path.join(root,`${id}.json`),16384)).toString("utf8")));if(operation.workspace!==canonical||operation.id!==id)throw new Error("GIT_OPERATION_IDENTITY_CHANGED");return operation;};
 let queue=Promise.resolve();const serial=<T>(fn:()=>Promise<T>)=>{const result=queue.then(fn);queue=result.then(()=>{},()=>{});return result;};
 const reconcile=async(id:string)=>{const operation=await readOperation(id),current=await text(["rev-parse","--verify",operation.branch]);if(current===operation.commit){if(operation.status!=="completed"){operation.status="completed";await persist(operation);}return operation;}if(operation.status==="completed")return operation;throw new Error("GIT_COMMIT_OUTCOME_UNCONFIRMED");};
 return{
  async reviewCommit(input:unknown):Promise<CommitReview>{return serial(async()=>{const parsed=inputSchema.parse(input);checkText(parsed.message);const state=await snapshot();if(new Set(parsed.paths).size!==parsed.paths.length||JSON.stringify([...parsed.paths].sort())!==JSON.stringify(state.files.map(file=>file.path).sort()))throw new Error("GIT_STAGED_SELECTION_MISMATCH");const author=await identity("AUTHOR"),committer=await identity("COMMITTER"),ticketId=randomUUID();
   const review:CommitReview={ticketId,branch:state.branch,head:state.head,tree:state.tree,message:parsed.message,files:state.files,author:`${author.name} <${author.email}>`,committer:`${committer.name} <${committer.email}>`,destination:"local",expiresAt:Date.now()+5*60000};tickets.set(ticketId,{review,indexDigest:state.indexDigest,author,committer});while(tickets.size>128)tickets.delete(tickets.keys().next().value!);return structuredClone(review);
  });},
  async commit(ticketId:string):Promise<CommitOperation>{return serial(async()=>{
   // Repeated accepted IDs reconcile durable state; never execute a second commit.
   try{return await reconcile(ticketId);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   const ticket=tickets.get(ticketId);if(!ticket)throw new Error("GIT_REVIEW_REQUIRED");tickets.delete(ticketId);if(ticket.review.expiresAt<=Date.now())throw new Error("GIT_REVIEW_EXPIRED");
   const state=await snapshot();if(state.branch!==ticket.review.branch||state.head!==ticket.review.head||state.tree!==ticket.review.tree||state.indexDigest!==ticket.indexDigest)throw new Error("GIT_REVIEW_CHANGED");
   const lock=await open(index+".lock","wx",0o600);try{
    if(digest(await safeRead(index,16*1024*1024))!==ticket.indexDigest||await text(["symbolic-ref","HEAD"])!==state.branch||await text(["rev-parse","HEAD"])!==state.head)throw new Error("GIT_REVIEW_CHANGED");
    const author=ticket.author,committer=ticket.committer;const commit=oid.parse((await git(["commit-tree",state.tree,"-p",state.head,"-m",ticket.review.message],{GIT_AUTHOR_NAME:author.name,GIT_AUTHOR_EMAIL:author.email,GIT_AUTHOR_DATE:author.date,GIT_COMMITTER_NAME:committer.name,GIT_COMMITTER_EMAIL:committer.email,GIT_COMMITTER_DATE:committer.date})).toString("utf8").trim());
    const operation:CommitOperation={id:ticketId,workspace:canonical,branch:state.branch,head:state.head,tree:state.tree,commit,status:"prepared"};await persist(operation);
    await git(["update-ref","-m","Harness reviewed commit",state.branch,commit,state.head]);operation.status="completed";await persist(operation);return operation;
   }finally{await lock.close();await unlink(index+".lock");}
  });},
  reconcile:(id:string)=>serial(()=>reconcile(id))
 };
}
