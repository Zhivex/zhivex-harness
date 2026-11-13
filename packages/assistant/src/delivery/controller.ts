import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { projectKey, canonicalProject, type openAssistantProjectRegistry } from '../projects.js';
import { openTaskWorktrees } from './task-worktrees.js';
import { openGitDelivery } from './git-delivery.js';
import { openRemoteDelivery } from './remote-delivery.js';
import { openPullRequestDelivery } from './pr-delivery.js';
import { openGitHubGitTransport } from './github-git-transport.js';
import { openGitHubPullRequestTransport } from './github-pr-transport.js';

/** Host-owned scope and admission. Renderer values never select a filesystem path. */
export function createTaskController(options: {
 directory:string; tasks:Awaited<ReturnType<typeof openTaskWorktrees>>; registry:Awaited<ReturnType<typeof openAssistantProjectRegistry>>;
 paused():boolean; control(key:string, operation:'pause'|'resume'):Promise<boolean>; stop(key:string):Promise<void>; secrets:readonly string[];
}) {
 const busy=new Set<string>(), removal=new Map<string,string>();
 const git=new Map<string,ReturnType<typeof openGitDelivery>>(), remotes=new Map<string,Promise<{transport:Awaited<ReturnType<typeof openGitHubGitTransport>>;push:Awaited<ReturnType<typeof openRemoteDelivery>>;pr:Awaited<ReturnType<typeof openPullRequestDelivery>>}>>();
 const registered=(key:string)=>{const p=options.registry.projects().find(p=>p.projectKey===key);if(!p)throw new Error('PROJECT_NOT_FOUND');const task=options.tasks.list().find(t=>t.workspace===p.canonicalPath);if(task&&task.status!=='ready')throw new Error('TASK_NOT_READY');return p;};
 const local=(key:string)=>{const p=registered(key);let pending=git.get(key);if(!pending){pending=openGitDelivery(p.canonicalPath,path.join(options.directory,'git',key),options.secrets);git.set(key,pending);void pending.catch(()=>git.delete(key));}return pending;};
 const remote=(key:string)=>{const p=registered(key);let pending=remotes.get(key);if(!pending){pending=(async()=>{const transport=await openGitHubGitTransport(p.canonicalPath);try{return{transport,push:await openRemoteDelivery(path.join(options.directory,'push',key),transport,options.secrets),pr:await openPullRequestDelivery(path.join(options.directory,'pr',key),openGitHubPullRequestTransport(transport),options.secrets)};}catch(e){await transport.close();throw e;}})();remotes.set(key,pending);void pending.catch(()=>remotes.delete(key));}return pending;};
 const mutate=async<T>(key:string,terminalBusy:(key:string)=>boolean,fn:()=>Promise<T>)=>{
  if(options.paused()||busy.has(key))throw new Error('TASK_OPERATION_BUSY');if(terminalBusy(key))throw new Error('TASK_TERMINAL_ACTIVE');busy.add(key);
  try{if(await options.control(key,'pause'))throw new Error('GIT_RUNTIME_BUSY');return await fn();}
  finally{if(!options.paused())await options.control(key,'resume').catch(()=>{});busy.delete(key);}
 };
 const view=(task:ReturnType<typeof options.tasks.get>)=>({...task,projectKey:projectKey(task.workspace),budget:{maxSteps:task.maxSteps,maxTotalTokens:60000,timeoutMs:300000}});
 return {
  busy:(key:string)=>busy.has(key),
  async action(input:unknown,terminalBusy:(key:string)=>boolean=()=>false):Promise<unknown>{
   const v=z.object({action:z.enum(['operations','list','create','stop','review-removal','remove','changes','stage','review-commit','commit','reconcile-commit','targets','review-push','push','reconcile-push','review-pr','pr','reconcile-pr']),projectKey:z.string().regex(/^project_[a-f0-9]{32}$/).optional(),taskId:z.string().uuid().optional(),ticketId:z.string().uuid().optional(),input:z.unknown().optional()}).strict().parse(input);
   if(v.projectKey){const p=registered(v.projectKey),task=options.tasks.list().find(t=>t.workspace===p.canonicalPath);if(task)await options.tasks.validate(task.id);}
   const id=()=>z.string().uuid().parse(v.ticketId);
   if(v.action==='list'){if(v.projectKey)registered(v.projectKey);return{tasks:options.tasks.list(v.projectKey).map(view),maxOpenTasks:2,delegation:false};}
   if(v.action==='create'){
    if(options.paused())throw new Error('RUNTIME_BUSY');if(options.registry.projects().length>=100)throw new Error('PROJECT_INDEX_LIMIT');const source=registered(z.string().parse(v.projectKey));
    if(options.tasks.list().some(t=>t.workspace===source.canonicalPath))throw new Error('NESTED_TASK_UNSUPPORTED');
    const task=await options.tasks.create({key:source.projectKey,workspace:source.canonicalPath},v.input);
    await options.registry.register({...await canonicalProject(task.workspace),name:task.title});return view(task);
   }
   if(['stop','review-removal','remove'].includes(v.action)){
    const taskId=v.action==='remove'?removal.get(id()):v.taskId;if(!taskId)throw new Error('TASK_REVIEW_REQUIRED');const task=options.tasks.get(taskId),key=projectKey(task.workspace);
    return mutate(key,terminalBusy,async()=>{
     if(v.action==='stop'){await options.stop(key);return{stopped:true};}
     if(v.action==='review-removal'){const review=await options.tasks.reviewRemoval(taskId);removal.set(review.ticketId,taskId);while(removal.size>128)removal.delete(removal.keys().next().value!);return review;}
     removal.delete(id());await options.stop(key);const result=await options.tasks.remove(id());return view(result);
    });
   }
   const key=z.string().parse(v.projectKey);registered(key);
   switch(v.action){
    case 'operations': {const entries=[];for(const kind of ['git','push','pr']){const names=await readdir(path.join(options.directory,kind,key)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return[];throw e;});for(const name of names)if(/^[a-f0-9-]{36}\.json$/.test(name))entries.push({kind:kind==='git'?'commit':kind,id:name.slice(0,-5)});}return entries.slice(-100);}
    case 'changes':return(await local(key)).changes();
    case 'stage':return mutate(key,terminalBusy,async()=>(await local(key)).stage(v.input));
    case 'review-commit':return(await local(key)).reviewCommit(v.input);
    case 'commit':return mutate(key,terminalBusy,async()=>(await local(key)).commit(id()));
    case 'reconcile-commit':return(await local(key)).reconcile(id());
    case 'targets':return(await remote(key)).transport.targets();
    case 'review-push':return(await remote(key)).push.reviewPush(v.input);
    case 'push':return mutate(key,terminalBusy,async()=>(await remote(key)).push.push(id()));
    case 'reconcile-push':return(await remote(key)).push.reconcile(id());
    case 'review-pr':return(await remote(key)).pr.review(v.input);
    case 'pr':return mutate(key,terminalBusy,async()=>(await remote(key)).pr.create(id()));
    case 'reconcile-pr':return(await remote(key)).pr.reconcile(id());
   }
  },
  async close(){await Promise.all([...remotes.values()].map(async entry=>{const value=await entry.catch(()=>undefined);await value?.transport.close();}));}
 };
}
