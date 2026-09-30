import { Agent, createFileAgentRunStore, cancelAgentRun, createTextMessage, tool, type AgentRunInput, type AgentRunOutput, type AgentRunState, type ModelMessage, type LanguageModel } from '@zhivex-ai/core';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AcceptanceFixture } from './fixtures.js';
import { ACCEPTANCE_LIMITS } from './fixtures.js';
import { runPortableProcess } from '../../src/execution/process-runtime.js';

type Engine=typeof import('../../src/engine/index.js');
/** Use the installed production transport (including signed continuation) for both agents. */
export const createPilotModel = (api:Engine,modelId:string,apiKey:string):LanguageModel =>
 api.DEFAULT_PROVIDER_REGISTRY.createModel({provider:'anthropic',model:modelId},{ANTHROPIC_API_KEY:apiKey});
export interface PilotSession {
  run(input:AgentRunInput):Promise<AgentRunOutput>;
  load(id:string):Promise<AgentRunState | undefined>;
  cancel(id:string):Promise<void>;
  close():Promise<void>;
}
export interface PilotAdapterOptions {workspace:string; fixture:AcceptanceFixture; model:LanguageModel; modelId:string;}
export function referenceSummary(messages:readonly ModelMessage[]) {
 const directives:string[]=[];
 for(const message of messages)for(const part of message.parts)if(part.type==='text'){
  if(message.role==='user')directives.push(part.text);
  else if(part.text.startsWith('[Compacted prior conversation]\n'))try{
   const parsed=JSON.parse(part.text.slice('[Compacted prior conversation]\n'.length));
   if(parsed.referenceContext===1 && Array.isArray(parsed.directives))directives.push(...parsed.directives.filter((s:unknown)=>typeof s==='string'));
  }catch{/* Unrecognized summaries are not instructions. */}
 }
 return JSON.stringify({referenceContext:1,directives:[...new Set(directives)].slice(-6).map(s=>s.slice(0,600))});
}

/** Small direct-SDK reference implementation, not a commercial competing product. */
export async function createSdkReference(options:PilotAdapterOptions):Promise<PilotSession> {
 const {workspace,fixture,model}=options;
 const readable=new Set([...Object.keys(fixture.files),'package.json','verify.mjs']);
 const editable=new Set(fixture.editable);
 const access=async(name:string,write=false)=>{
  if(!(write?editable:readable).has(name))throw new Error('REFERENCE_PATH_DENIED');
  const file=await open(path.join(workspace,name),(write?constants.O_RDWR:constants.O_RDONLY)|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error('REFERENCE_FILE_DENIED');return file;}catch(error){await file.close();throw error;}
 };
 const digest=(bytes:Buffer)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
 const tools={
  list_files:tool({name:'list_files',description:'List readable fixture paths.',schema:z.object({}),execute:()=>[...readable]}),
  read_file:tool({name:'read_file',description:'Read a fixture file and its expectedDigest for a subsequent write.',schema:z.object({path:z.string()}),execute:async({path:name})=>{const file=await access(name);try{const bytes=await file.readFile();return {path:name,content:bytes.toString('utf8'),expectedDigest:digest(bytes)};}finally{await file.close();}}}),
  write_file:tool({name:'write_file',description:'Replace a file with operator approval and the digest returned by read_file.',requiresApproval:true,approvalMode:'interrupt',schema:z.object({path:z.string(),content:z.string().max(16383),expectedDigest:z.string()}),execute:async({path:name,content,expectedDigest},context)=>{
   const file=await access(name,true);try{if(digest(await file.readFile())!==expectedDigest)throw new Error('REFERENCE_DIGEST_CONFLICT');context?.abortSignal?.throwIfAborted();const bytes=Buffer.from(content);const result=await file.write(bytes,0,bytes.length,0);if(result.bytesWritten!==bytes.length)throw new Error('REFERENCE_SHORT_WRITE');await file.truncate(bytes.length);await file.sync();return {path:name,written:true};}finally{await file.close();}
  }}),
  run_check:tool({name:'run_check',description:'Run the protected test script. Request approval by calling this tool.',requiresApproval:true,approvalMode:'interrupt',schema:z.object({check:z.literal('test'),expectedScript:z.literal('bun verify.mjs')}),execute:async(_args,context)=>{
   const result=await runPortableProcess(['bun','--no-env-file','verify.mjs'],{cwd:workspace,env:{PATH:process.env.PATH},timeoutMs:10000,maxOutputCharacters:8192,...(context?.abortSignal?{signal:context.abortSignal}:{})});
   return {exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr};
  }})
 };
 const store=createFileAgentRunStore({directory:path.join(workspace,'.reference-state')});
 const agent=new Agent({model,tools,store,maxSteps:ACCEPTANCE_LIMITS.maxSteps,policy:{budget:ACCEPTANCE_LIMITS,timeoutMs:ACCEPTANCE_LIMITS.timeoutMs},
  instructions:'Complete the user task using the available file and check tools. Read files before editing. Run requested checks and use their results. The runtime pauses tool calls for operator approval; call the tool to request approval. Do not edit protected tests or package.json. Finish only when the task is complete.',
  ...(fixture.mode==='restart'?{compaction:{maxMessages:8,keepRecentMessages:2,compactor:({messages}: {messages:ModelMessage[]})=>({summary:referenceSummary(messages)})}}:{})});
 return {run:input=>agent.stream(input).collect(),load:async id=>store.load(id),cancel:async id=>{await cancelAgentRun(store,id,{mode:'final',reason:'Pilot cancellation'});},close:async()=>{}};
}
export async function createHarnessPilot(api:Engine,options:PilotAdapterOptions):Promise<PilotSession> {
 const harness=await api.createHarness({provider:'anthropic',model:options.modelId,modelInstance:options.model,workspace:options.workspace,...ACCEPTANCE_LIMITS,allowedChecks:['test'],requireVerifiedDelivery:false,projectContext:false,subagentProfiles:[],
  ...(options.fixture.mode==='restart'?{compactionMaxMessages:8,compactionKeepRecentMessages:2,compactionMaxEstimatedInputTokens:10000}:{})});
 return {run:input=>api.runHarness(harness,input),load:async id=>harness.store.load(id,harness.config.scope),cancel:async id=>{await api.cancelHarnessRun(harness.store,harness.config,id,{reason:'Pilot cancellation',final:true});},close:()=>harness.close()};
}
export const pilotCorrection=(state:AgentRunState,text:string):AgentRunInput=>({messages:[...state.messages,createTextMessage('user',text)]});
