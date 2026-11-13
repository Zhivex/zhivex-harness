/** Live gate, run only after explicit approval for OpenAI egress. Never edits a real project. */
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {systemSecrets} from '../src/web/secrets.js';
import {decodeSaved} from '../src/web/setup-state.js';
import {providerConfig} from '../src/web/setup.js';
import {createCompatibleProvider} from '../src/providers/openai-compatible.js';
import {wrapLanguageModel,type TokenUsage} from '@zhivex-ai/core';
import {startAssistantHost} from '../src/host.js';
const unwrap=<T>(v:{ok:true;data:T}|{ok:false;error:unknown}):T=>{if(!v.ok)throw Error('PILOT_PROVIDER_RUN_FAILED');return v.data;};
const requests:{status:number}[]=[],usage:Required<Pick<TokenUsage,'inputTokens'|'outputTokens'|'totalTokens'>>={inputTokens:0,outputTokens:0,totalTokens:0};
let modelName:string|undefined,lastRunStatus:string|undefined,lastRunError:string|undefined;
const record=(value:TokenUsage|undefined)=>{if(!value)return;usage.inputTokens+=value.inputTokens??0;usage.outputTokens+=value.outputTokens??0;usage.totalTokens+=value.totalTokens??((value.inputTokens??0)+(value.outputTokens??0));};
let root:string|undefined,host:Awaited<ReturnType<typeof startAssistantHost>>|undefined;
try{
 if(!process.argv.includes('--approve-openai-fixture-egress'))throw Error('PILOT_OPENAI_APPROVAL_REQUIRED');
 const directory=await realpath(homedir()+'/.zhx-app'),stored=await systemSecrets(directory).read();if(!stored)throw Error('PILOT_PROVIDER_NOT_CONFIGURED');
 const saved=decodeSaved(stored),profile=saved.profiles.find(p=>p.id===saved.active);if(!profile?.provider)throw Error('PILOT_PROVIDER_NOT_CONFIGURED');
 const config=providerConfig(profile.provider);
 if(config.kind!=='openai-compatible'||config.baseURL!=='https://api.openai.com/v1')throw Error('PILOT_APPROVED_DESTINATION_MISMATCH');
 // The coding journey is itself the access probe; no unbudgeted generation precedes it.
 const {webSearch:_webSearch,...fixtureConfig}=config;modelName=config.model;
 const provider=createCompatibleProvider(fixtureConfig,{env:{ASSISTANT_WEB_MODEL_KEY:profile.provider.apiKey},fetcher:(async(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
  const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(target.origin!=='https://api.openai.com'||!['/v1/chat/completions','/v1/responses'].includes(target.pathname))throw Error('PILOT_APPROVED_DESTINATION_MISMATCH');
  const response=await fetch(input,{...init,redirect:'error'});requests.push({status:response.status});return response;
 }) as typeof fetch});
 const model=wrapLanguageModel(provider.model,[{name:'pilot-live-observer',async wrapGenerate({input},next){input.maxRetries=0;const result=await next();record(result.usage);return result;},async wrapStream({input},next){input.maxRetries=0;const stream=await next();return(async function*(){for await(const event of stream){if(event.type==='finish')record(event.usage);yield event;}})();}}]);
 root=await mkdtemp('/tmp/pilot-live-');const repo=root+'/repo';await mkdir(repo);execFileSync('git',['init','-q',repo]);
 const script=`node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'AFTER\\n')"`;
 await writeFile(repo+'/answer.txt','BEFORE\n');await writeFile(repo+'/package.json',JSON.stringify({scripts:{test:script}}));
 host=await startAssistantHost({directory:root+'/state',ownerId:'pilot-fixture',engine:{provider:'openai',model:config.model,modelInstance:model},coding:{execution:'local',configurationId:'pilot-live-v1',sensitiveValues:[profile.provider.apiKey],engine:{maxSteps:8,maxTotalTokens:16000,maxInputTokens:13000,maxOutputTokens:3000,unlimitedTokens:false,unlimitedSteps:false,unlimitedToolCalls:false,unlimitedDuration:false,toolNames:['read_file','apply_reviewed_replacement','run_check'],maxToolCalls:16,maxToolErrors:2,timeoutMs:90000}}});
 const app=host.application!,project=unwrap(await app.client.registerProject(await app.selectProject(repo))),conversation=unwrap(await app.client.createConversation({context:{kind:'project',projectKey:project.projectKey},idempotencyKey:randomUUID()})),conversationId=conversation.conversationId;
 unwrap(await app.send({conversationId,prompt:'In this disposable fixture, inspect answer.txt with read_file, then use apply_reviewed_replacement to replace BEFORE with AFTER, keeping the newline. Then run_check test using the exact package.json script. Do not change any other file or run any other command. Summarize the check result.',key:randomUUID()}));
 let approvals=0,runId='';
 for(let i=0;i<4;i++){
  const snapshot=unwrap(await app.client.snapshot(conversationId)),run=snapshot.runs.at(-1)!;runId=run.runId;lastRunStatus=run.status;lastRunError=run.error?.code;
  if(run.status==='completed')break;if(run.status!=='waiting_approval')throw Error('PILOT_PROVIDER_RUN_FAILED');
  const ticket=unwrap(await app.client.review({conversationId,target:{kind:'effect',runId}}));if(ticket.preview.kind!=='effect')throw Error('PILOT_UNEXPECTED_REVIEW');
  for(const item of ticket.preview.review.items){
   const args=JSON.parse(item.payload);
   if(item.name==='apply_reviewed_replacement'){
    if(args.path!=='answer.txt'||!['BEFORE','BEFORE\n'].includes(args.oldText)||args.newText!==args.oldText.replace('BEFORE','AFTER'))throw Error('PILOT_UNEXPECTED_EFFECT');
   }else if(item.name==='run_check'){if(args.check!=='test'||args.expectedScript!==script)throw Error('PILOT_UNEXPECTED_EFFECT');}
   else throw Error('PILOT_UNEXPECTED_EFFECT');
  }
  const decision=unwrap(await app.client.decide({conversationId,ticketId:ticket.ticketId,approve:true,idempotencyKey:randomUUID()}));if(!decision.ok)throw Error('PILOT_DECISION_FAILED');approvals++;
 }
 const outputs=await app.outputs({conversationId,runId}),snapshot=unwrap(await app.client.snapshot(conversationId));
 if(snapshot.runs.at(-1)?.status!=='completed'||await readFile(repo+'/answer.txt','utf8')!=='AFTER\n'||!outputs.some(o=>o.exitCode===0)||approvals<2)throw Error('PILOT_PROVIDER_JOURNEY_INCOMPLETE');
 console.log(JSON.stringify({gate:'real-provider-coding',status:'passed',model:config.model,approvals,editedOnlyFixture:true,checkExitCode:0,requests,usage,maxTotalTokens:16000}));
}catch(error){const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'PILOT_PROVIDER_UNAVAILABLE';console.log(JSON.stringify({gate:'real-provider-coding',status:'blocked',code,model:modelName,lastRunStatus,lastRunError,requests,usage,maxTotalTokens:16000,credentialsPrinted:false}));process.exitCode=1;}
finally{await host?.close();if(root)await rm(root,{recursive:true,force:true});}
