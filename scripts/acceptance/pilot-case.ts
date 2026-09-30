import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,lstat,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTextMessage,wrapLanguageModel,type LanguageModel,type AgentApprovalRequest,type AgentRunOutput} from '@zhivex-ai/core';
import {runPortableProcess} from '../../src/execution/process-runtime.js';
import {ACCEPTANCE_LIMITS,type AcceptanceFixture} from './fixtures.js';
import {createPilotBudget} from './pilot-budget.js';
import {createSdkReference,createHarnessPilot,pilotCorrection,type PilotSession} from './pilot-adapters.js';

type Engine=typeof import('../../src/engine/index.js');
export async function runPilotCase(api:Engine,participant:'harness'|'sdk-reference',fixture:AcceptanceFixture,baseModel:LanguageModel,modelId:string,onError?:(error:unknown)=>void) {
 const meter=createPilotBudget(ACCEPTANCE_LIMITS);
 const signal=AbortSignal.timeout(ACCEPTANCE_LIMITS.timeoutMs);
 const root=await mkdtemp(path.join(os.tmpdir(),'har-competitive-'));
 const workspace=path.join(root,'workspace'),verifier=path.join(root,'verifier');
 const model=wrapLanguageModel(baseModel,[meter.middleware]);
 let session:PilotSession|undefined,automatedApprovals=0,scriptedUserCorrections=0,reopened=false,compactions=0,failedCheck=false;
 let status:'passed'|'failed'='failed',diagnostic:'none'|'verification_failed'|'budget_exhausted'|'provider_failed'='verification_failed';
 let independentTestsPassed=false,protectedFilesUnchanged=false,initialTestsFailed=false;
 const originals={...fixture.files,'verify.mjs':fixture.mode==='correction'?fixture.oracle.split('assert.equal(cents(-1.005)')[0]!:fixture.oracle,
  'package.json':JSON.stringify({private:true,type:'module',packageManager:'bun@1.4.0',scripts:{test:'bun verify.mjs'}})};
 const read=(name:string)=>readFile(path.join(workspace,name),'utf8');
 const unchanged=async()=>{for(const [name,content] of Object.entries(originals))if(!fixture.editable.includes(name)&&await read(name).catch(()=>null)!==content)return false;return true;};
 const open=()=>participant==='harness'?createHarnessPilot(api,{workspace,fixture,model,modelId}):createSdkReference({workspace,fixture,model,modelId});
 const approve=(batch:readonly AgentApprovalRequest[])=>batch.map(a=>{
  const args=JSON.parse(a.arguments);
  const write=a.name==='write_file'&&fixture.editable.includes(args.path)&&typeof args.content==='string'&&args.content.length<16384;
  const edit=['apply_reviewed_edits','apply_patch'].includes(a.name)&&Array.isArray(args.changes)&&args.changes.length>0&&args.changes.every((c:{path:string;content:string})=>fixture.editable.includes(c.path)&&typeof c.content==='string'&&c.content.length<16384);
  const replace=a.name==='apply_reviewed_replacement'&&fixture.editable.includes(args.path)&&typeof args.newText==='string'&&args.newText.length<16384;
  const check=a.name==='run_check'&&args.check==='test'&&args.expectedScript==='bun verify.mjs';
  assert(write||edit||replace||check,'PILOT_APPROVAL_POLICY');automatedApprovals++;
  return {provider:a.provider,approvalRequestId:a.id,approve:true,reason:'Automated fixed fixture policy, not human intervention.'};
 });
 const observe=(result:AgentRunOutput)=>{
  compactions=Math.max(compactions,result.state.compactions?.length??0);
  failedCheck ||= result.state.toolResults.some(t=>t.toolName==='run_check'&&t.output&&typeof t.output==='object'&&'exitCode' in t.output&&t.output.exitCode!==0);
 };
 const finish=async(initial:AgentRunOutput)=>{let result=initial;observe(result);while(result.status==='waiting_approval'){
  meter.check();result=await session!.run({state:result.state,approvals:approve(result.state.pendingApprovals),abortSignal:signal});observe(result);
 }return result;};
 try {
  await mkdir(path.join(workspace,'src'),{recursive:true});for(const [name,content] of Object.entries(originals))await writeFile(path.join(workspace,name),content);
  const initial=await runPortableProcess(['bun','--no-env-file','verify.mjs'],{cwd:workspace,signal,timeoutMs:10000});initialTestsFailed=initial.exitCode!==0;assert(initialTestsFailed);
  session=await open();
  const messages=fixture.mode==='restart'?[...Array.from({length:8},(_,i)=>createTextMessage(i%2?'assistant':'user',`Context ${i}: preserve protected tests.`)),createTextMessage('user',fixture.task)]:[createTextMessage('user',fixture.task)];
  let result=await session.run({messages,abortSignal:signal});observe(result);assert.equal(result.status,'waiting_approval');
  for(const name of fixture.editable)assert.equal(await read(name),fixture.files[name]);
  if(fixture.mode==='cancellation'){
   await session.cancel(result.state.runId);const state=await session.load(result.state.runId);assert(state);
   result=await session.run({state,abortSignal:signal});observe(result);assert.equal(result.status,'cancelled');
   for(const name of fixture.editable)assert.equal(await read(name),fixture.files[name]);independentTestsPassed=true;
  }else{
   if(fixture.mode==='restart'){
    const runId=result.state.runId;await session.close();session=await open();const state=await session.load(runId);assert(state);result={...result,state};reopened=true;
   }
   result=await finish(result);assert.equal(result.status,'completed');
   if(fixture.mode==='failed-check')assert(failedCheck);
   if(fixture.mode==='correction'){
    scriptedUserCorrections=1;result=await finish(await session.run({...pilotCorrection(result.state,fixture.correction!),abortSignal:signal}));assert.equal(result.status,'completed');
   }
   if(fixture.mode==='restart')assert(reopened&&compactions>0);
   await mkdir(path.join(verifier,'src'),{recursive:true});await writeFile(path.join(verifier,'package.json'),'{"type":"module"}');
   for(const name of fixture.editable){const stat=await lstat(path.join(workspace,name));assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<16384);await writeFile(path.join(verifier,name),await read(name));assert.notEqual(await read(name),fixture.files[name]);}
   await writeFile(path.join(verifier,'verify.mjs'),fixture.oracle);
   independentTestsPassed=(await runPortableProcess(['bun','--no-env-file','verify.mjs'],{cwd:verifier,timeoutMs:10000,signal})).exitCode===0;assert(independentTestsPassed);
  }
  protectedFilesUnchanged=await unchanged();assert(protectedFilesUnchanged);
  assert.deepEqual((await readdir(path.join(workspace,'src'))).sort(),fixture.editable.map(n=>path.basename(n)).sort());
  meter.check();assert(meter.stats.usageComplete);status='passed';diagnostic='none';
 }catch(error){onError?.(error);diagnostic=meter.stats.budgetExhausted||signal.aborted||error instanceof Error&&error.message==='PILOT_BUDGET_EXHAUSTED'?'budget_exhausted':!meter.stats.usageComplete?'provider_failed':'verification_failed';}
 finally{protectedFilesUnchanged=await unchanged();await session?.close();await rm(root,{recursive:true,force:true});}
 const measurement=meter.snapshot();if(measurement.durationMs>ACCEPTANCE_LIMITS.timeoutMs){status='failed';diagnostic='budget_exhausted';}
 return {status,diagnostic,independentTestsPassed,protectedFilesUnchanged,initialTestsFailed,automatedApprovals,humanInterventions:0,scriptedUserCorrections,reopened,compactions,failedCheck,...measurement};
}
