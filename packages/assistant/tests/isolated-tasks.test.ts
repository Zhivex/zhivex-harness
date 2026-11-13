import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startAssistantHost} from '../src/host.js';
import type {AssistantApplicationResult} from '../src/application-contracts.js';
const unwrap=<T>(v:AssistantApplicationResult<T>)=>{if(!v.ok)throw Error(v.error.code);return v.data;};
type Task={id:string;workspace:string;stateDirectory:string;projectKey:string;budget:{maxSteps:number}};
const git=(repo:string,args:string[])=>execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{encoding:'utf8'}).trim();
test('two managed task runtimes isolate files and approvals, enforce capacity and preserve dirty source',async()=>{
 const root=await mkdtemp('/tmp/assistant-task-');await mkdir(root+'/repo');git(root+'/repo',['init','-q','-b','main']);await writeFile(root+'/repo/note.txt','before');git(root+'/repo',['add','.']);git(root+'/repo',['commit','-qm','baseline']);await writeFile(root+'/repo/note.txt','source dirty');
 const edit=(text:string)=>[{type:'tool-call' as const,toolCall:{id:randomUUID(),name:'apply_reviewed_replacement',input:{path:'note.txt',expectedDigest:'sha256:'+createHash('sha256').update('before').digest('hex'),oldText:'before',newText:text}}},{type:'finish' as const,finishReason:'tool-calls' as const}];
 const done=[{type:'text-delta' as const,textDelta:'Done'},{type:'finish' as const,finishReason:'stop' as const}];
 const model=createMockLanguageModel({streamEvents:[edit('one'),edit('two'),done,done]});
 const host=await startAssistantHost({directory:root+'/state',ownerId:'tasks',engine:{modelInstance:model},coding:{execution:'local',configurationId:'tasks'}});
 try{const app=host.application!;const project=unwrap(await app.client.registerProject(await app.selectProject(root+'/repo')));
 const create=(title:string)=>app.taskAction({action:'create',projectKey:project.projectKey,input:{title,initialState:'committed-head',maxSteps:8}}) as Promise<Task>;
 const a=await create('One'),b=await create('Two'),c=await create('Three');expect(a.budget.maxSteps).toBe(8);
 const conversation=async(task:Task)=>unwrap(await app.client.createConversation({context:{kind:'project',projectKey:task.projectKey},idempotencyKey:randomUUID()}));const [ca,cb]=await Promise.all([conversation(a),conversation(b)]);
 expect(ca.engineProjectId).not.toBe(cb.engineProjectId);await expect(conversation(c)).rejects.toThrow('RUNTIME_BUSY');
 await Promise.all([app.send({conversationId:ca.conversationId,prompt:'Edit first',key:randomUUID()}),app.send({conversationId:cb.conversationId,prompt:'Edit second',key:randomUUID()})]);
 const sa=unwrap(await app.client.snapshot(ca.conversationId)),sb=unwrap(await app.client.snapshot(cb.conversationId));expect(sa.runs[0]?.status).toBe('waiting_approval');expect(sb.runs[0]?.status).toBe('waiting_approval');
 const review=async(cid:string,runId:string)=>unwrap(await app.client.review({conversationId:cid,target:{kind:'effect',runId}}));
 const ra=await review(ca.conversationId,sa.runs[0]!.runId);const wrong=await app.client.decide({conversationId:cb.conversationId,ticketId:ra.ticketId,approve:true,idempotencyKey:randomUUID()});expect(wrong.ok).toBe(false);
 for(const [cid,rid] of [[ca.conversationId,sa.runs[0]!.runId],[cb.conversationId,sb.runs[0]!.runId]]){const receipt=await review(cid!,rid!);expect((await app.client.decide({conversationId:cid!,ticketId:receipt.ticketId,approve:true,idempotencyKey:randomUUID()})).ok).toBe(true);}
 expect(new Set([await readFile(a.workspace+'/note.txt','utf8'),await readFile(b.workspace+'/note.txt','utf8')])).toEqual(new Set(['one','two']));expect(await readFile(root+'/repo/note.txt','utf8')).toBe('source dirty');
 const removal=await app.taskAction({action:'review-removal',taskId:a.id}) as {canRemove:boolean;ticketId:string;changedPaths:string[]};expect(removal.canRemove).toBe(false);expect(removal.changedPaths).toContain('note.txt');await expect(app.taskAction({action:'remove',ticketId:removal.ticketId})).rejects.toThrow('TASK_HAS_UNINTEGRATED_CHANGES');
 await app.taskAction({action:'stop',taskId:b.id});await conversation(c); // frees capacity without removing data
 await expect(app.taskAction({action:'stop',taskId:c.id},()=>true)).rejects.toThrow('TASK_TERMINAL_ACTIVE');
 const branch=git(c.workspace,['branch','--show-current']);git(c.workspace,['checkout','-qb','feat/changed-identity']);await expect(app.taskAction({action:'changes',projectKey:c.projectKey})).rejects.toThrow('TASK_WORKSPACE_CHANGED');git(c.workspace,['checkout','-q',branch]);
 const clean=await app.taskAction({action:'review-removal',taskId:c.id}) as {canRemove:boolean;ticketId:string};expect(clean.canRemove).toBe(true);await app.taskAction({action:'remove',ticketId:clean.ticketId});await expect(readFile(c.workspace+'/note.txt','utf8')).rejects.toThrow();expect(await readFile(root+'/repo/note.txt','utf8')).toBe('source dirty');
 }finally{await host.close();await rm(root,{recursive:true,force:true});}
},30000);
