/** Offline stage-3 fixture. A real Code terminal starts the run owned by Assistant. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startAssistantHost } from '../src/host.js';
import { startAssistantWeb } from '../src/web/server.js';
import { nativeProjectSelection } from '../src/native-selection.js';
import type { AssistantApplicationResult } from '../src/application-contracts.js';
const unwrap = <T>(r: AssistantApplicationResult<T>) => { if (!r.ok) throw new Error(r.error.code); return r.data; };
export async function reviewFixture(native = false) {
 const root=await mkdtemp('/tmp/review-smoke-'),repo=root+'/sample-project'; await mkdir(repo); execFileSync('git',['init','-q',repo]);
 await writeFile(repo+'/note.txt','before\n'); await writeFile(repo+'/package.json',JSON.stringify({scripts:{test:'node -e "console.log(123)"'}})); await writeFile(repo+'/.gitignore','.zhivex-harness/\n');
 for(const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','baseline']]) execFileSync('git',args,{cwd:repo});
 const done=(text:string)=>[{type:'text-delta' as const,textDelta:text},{type:'finish' as const,finishReason:'stop' as const,usage:{inputTokens:10,outputTokens:5,totalTokens:15}}];
 const check=[{type:'tool-call' as const,toolCall:{id:'check',name:'run_check',input:{check:'test',expectedScript:'node -e "console.log(123)"'}}},{type:'finish' as const,finishReason:'tool-calls' as const,usage:{inputTokens:10,outputTokens:5,totalTokens:15}}];
 const model=createMockLanguageModel({streamEvents:[done('Baseline ready.'),[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'note.txt',expectedDigest:'sha256:'+createHash('sha256').update('before\n').digest('hex'),oldText:'before',newText:'after'}}},{type:'finish',finishReason:'tool-calls'}],check,done('Edited and checked.'),done('Follow-up complete.'),check,done('Task checked.')]});
 const host=await startAssistantHost({directory:root+'/state',ownerId:'review-smoke',engine:{modelInstance:model,model:'offline-review-fixture'},coding:{execution:'local',configurationId:'review-smoke-v1'}});
 const app=host.application!;const project=unwrap(await app.client.registerProject(await app.selectProject(repo)));const binding=unwrap(await app.client.createConversation({context:{kind:'project',projectKey:project.projectKey},title:'Review fixture',idempotencyKey:randomUUID()}));
 await app.send({conversationId:binding.conversationId,prompt:'Inspect baseline',key:randomUUID()});let snapshot=unwrap(await app.client.snapshot(binding.conversationId));
 await app.reviewAction({conversationId:binding.conversationId,command:{method:'checkpoint.capture',turnId:snapshot.session.runs[0]!.turnId,paths:['note.txt'],expectedRevision:snapshot.session.revision,idempotencyKey:randomUUID()}});
 const connection=await app.projectConnection(project.projectKey);
 const codeRoot=process.env.ASSISTANT_REVIEW_CODE_ROOT ?? fileURLToPath(new URL('../../..',import.meta.url));
 const cli=(args:string[])=>new Promise<string>((resolve,reject)=>{const child=spawn('bun',['--no-env-file','packages/code/src/cli.ts',...args,'--session',binding.sessionId,'--service',connection.credentialsPath,'--json'],{cwd:codeRoot,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('exit',code=>code===0?resolve(stdout):reject(new Error(stderr+stdout)));});
 await cli(['run','Edit note and run the test']);
 const selection=native?nativeProjectSelection(process.stdin,process.stdout,()=>void close().then(()=>process.exit(0))):undefined;
 const web=await startAssistantWeb(host,{assetsDirectory:fileURLToPath(new URL('../web/dist',import.meta.url)),chooseProject:selection?selection.choose:async()=>repo});
 async function close(){await web.close();await host.close();await rm(root,{recursive:true,force:true});}
 return {...web,root,repo,binding,app,cli,close};
}
if(process.argv.includes('--native-review')){const app=await reviewFixture(true);await writeFile('/tmp/tauri-stage3/native-fixture.json',JSON.stringify({repo:app.repo,url:app.url}),{mode:0o600});process.stdout.write(JSON.stringify({url:app.url})+'\n');process.stdin.resume();}
