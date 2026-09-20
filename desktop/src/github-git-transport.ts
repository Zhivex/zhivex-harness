import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {realpath,mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {pushDestinationSchema,type PushDestination,type PushSnapshot,type RemoteTransport} from "./remote-delivery.js";
export interface RemoteTargets {branch:string;remotes:Array<{remote:string;url:string}>;unsupported:number}
const execute=promisify(execFile),object=/^[a-f0-9]{40,64}$/;

/** GitHub HTTPS transport. Auth stays in Git/gh, never in snapshots or IPC. */
export async function openGitHubGitTransport(workspace:string):Promise<RemoteTransport&{close():Promise<void>;targets():Promise<RemoteTargets>}>{
 const root=await realpath(workspace);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",GH_PROMPT_DISABLED:"1"};
 const protections=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never","-c","protocol.https.allow=always","-c","http.followRedirects=false","-c","http.sslVerify=true","-c","http.extraHeader=","-c","http.proxy=","-c","credential.helper=","-c","credential.helper=!gh auth git-credential","-c","push.followTags=false","-c","push.recurseSubmodules=no","-c","remote.pushDefault="];
 const command=async(directory:string,args:string[])=>{try{return(await execute("git",["-C",directory,...protections,...args],{env,encoding:"buffer",timeout:30000,maxBuffer:3*1024*1024})).stdout;}catch{throw new Error("REMOTE_GIT_FAILED");}};
 const git=(args:string[])=>command(root,args);
 const text=async(args:string[])=>new TextDecoder("utf-8",{fatal:true}).decode(await git(args)).trim();
 if(await realpath(await text(["rev-parse","--show-toplevel"]))!==root)throw new Error("REMOTE_WORKSPACE_CHANGED");
 // Network commands use a private bare repository so local URL rewrites,
 // URL-scoped headers, proxies and remote helpers cannot redirect credentials.
 const networkRoot=await mkdtemp(path.join(os.tmpdir(),"harness-git-transport-"));
 try{const format=await text(["rev-parse","--show-object-format"]);if(!["sha1","sha256"].includes(format))throw new Error("REMOTE_OBJECT_FORMAT");await command(networkRoot,["init","--bare",`--object-format=${format}`,"."]);const objects=await realpath(await text(["rev-parse","--path-format=absolute","--git-path","objects"]));if(/[\r\n]/.test(objects))throw new Error("REMOTE_OBJECT_PATH");await writeFile(path.join(networkRoot,"objects/info/alternates"),objects+"\n",{mode:0o600});}catch(error){await rm(networkRoot,{recursive:true,force:true});throw error;}
 const network=(args:string[])=>command(networkRoot,args);
 const networkText=async(args:string[])=>new TextDecoder("utf-8",{fatal:true}).decode(await network(args)).trim();
 const validate=async(input:PushDestination)=>{const destination=pushDestinationSchema.parse(input);const urls=(await text(["remote","get-url","--push","--all",destination.remote])).split("\n");if(urls.length!==1||urls[0]!==destination.url)throw new Error("REMOTE_DESTINATION_CHANGED");return destination;};
 const remoteHead=async(destination:PushDestination,ref=destination.ref)=>{const output=await networkText(["ls-remote","--refs",destination.url,ref]);if(!output)return null;const lines=output.split("\n");if(lines.length!==1)throw new Error("REMOTE_REF_AMBIGUOUS");const [id,name]=lines[0]!.split("\t");if(!id||!object.test(id)||name!==ref)throw new Error("REMOTE_REF_INVALID");return id;};
 const obtain=async(destination:PushDestination,id:string)=>{if(!object.test(id))throw new Error("REMOTE_REF_INVALID");try{await network(["cat-file","-e",`${id}^{commit}`]);}catch{await network(["fetch","--no-tags","--no-write-fetch-head","--no-recurse-submodules",destination.url,id]);}};
 return{
  close:()=>rm(networkRoot,{recursive:true,force:true}),
  async targets(){const branch=await text(["symbolic-ref","HEAD"]),names=(await text(["remote"])).split("\n").filter(Boolean),remotes:RemoteTargets["remotes"]=[];let unsupported=0;if(names.length>100)throw new Error("REMOTE_LIMIT");for(const name of names){try{const urls=(await text(["remote","get-url","--push","--all",name])).split("\n");if(urls.length!==1)throw new Error("REMOTE_MULTIPLE_URLS");const target=pushDestinationSchema.parse({remote:name,url:urls[0],ref:branch,baseRef:"refs/heads/main"});remotes.push({remote:target.remote,url:target.url});}catch{unsupported++;}}return{branch,remotes,unsupported};},
  async readHead(input){const destination=await validate(input);return remoteHead(destination);},
  async inspect(input){
   const destination=await validate(input),head=await text(["rev-parse","HEAD"]),branch=await text(["symbolic-ref","HEAD"]);if(!object.test(head))throw new Error("REMOTE_HEAD_INVALID");
   const remote=await remoteHead(destination),base=await remoteHead(destination,destination.baseRef);if(!base)throw new Error("REMOTE_BASE_MISSING");await obtain(destination,base);if(remote)await obtain(destination,remote);
   const ancestor=remote??base;let fastForward=true;try{await network(["merge-base","--is-ancestor",ancestor,head]);}catch{fastForward=false;}
   const staged=new TextDecoder("utf-8",{fatal:true}).decode(await git(["diff","--cached","--name-only","-z","--no-ext-diff","--no-textconv"])).split("\0").filter(Boolean);
   if(!fastForward)return{branch,head,destination,remoteHead:remote,baseHead:base,fastForward,stagedPaths:staged,commits:[]};
   const ids=(await networkText(["rev-list","--reverse",`${ancestor}..${head}`])).split("\n").filter(Boolean);if(ids.length>100)throw new Error("REMOTE_HISTORY_TOO_LARGE");
   const commits:PushSnapshot["commits"]=[];let total=0;
   for(const id of ids){
    const message=await networkText(["show","-s","--format=%B",id]);const parents=(await networkText(["rev-list","--parents","-n","1",id])).split(" ").slice(1);if(!parents.length)throw new Error("REMOTE_HISTORY_INCOMPLETE");
    const files:PushSnapshot["commits"][number]["files"]=[];
    for(const parent of parents){const entries=new TextDecoder("utf-8",{fatal:true}).decode(await network(["diff-tree","-r","--raw","-z","--no-renames","--no-ext-diff","--no-textconv",parent,id])).split("\0").filter(Boolean);
     for(let i=0;i<entries.length;i+=2){const match=/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) [AMD]$/.exec(entries[i]!);if(!match||!entries[i+1])throw new Error("REMOTE_DIFF_UNSUPPORTED");if(![match[1],match[2]].every(mode=>["000000","100644","100755"].includes(mode!)))throw new Error("REMOTE_MODE_UNSUPPORTED");
      const blob=async(id:string)=>{if(/^0+$/.test(id))return "";const bytes=await network(["cat-file","blob",id]);total+=bytes.length;if(bytes.length>256*1024||total>2*1024*1024||bytes.includes(0))throw new Error("REMOTE_PREVIEW_INCOMPLETE");return new TextDecoder("utf-8",{fatal:true}).decode(bytes);};
      files.push({path:entries[i+1]!,before:await blob(match[3]!),after:await blob(match[4]!),beforeMode:match[1] as "000000"|"100644"|"100755",afterMode:match[2] as "000000"|"100644"|"100755",parent});if(files.length>100)throw new Error("REMOTE_PREVIEW_INCOMPLETE");
     }
    }
    commits.push({id,message,files});
   }
   return{branch,head,destination,remoteHead:remote,baseHead:base,fastForward,stagedPaths:staged,commits};
  },
  async push(head,input){const destination=await validate(input);if(!object.test(head))throw new Error("REMOTE_HEAD_INVALID");
   // Exact SHA and one explicit ref; ordinary Git rejects non-fast-forward races.
   // Never add force, mirror, all, tags or a repository-defined refspec.
   await network(["push","--no-verify","--porcelain","--recurse-submodules=no",destination.url,`${head}:${destination.ref}`]);
  }
 };
}
