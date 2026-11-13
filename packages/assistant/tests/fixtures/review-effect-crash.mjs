// Fault injection lives only in this disposable process, never in the product host.
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { createCodingHarness } from '@zhivex-ai/harness/engine';
import { startHarnessLocalService, recoverHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService } from '@zhivex-ai/harness/service';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
const [root,mode]=process.argv.slice(2);
const model=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'note.txt',expectedDigest:'sha256:'+createHash('sha256').update('before').digest('hex'),oldText:'before',newText:'after'}}},{type:'finish',finishReason:'tool-calls'}]]});
const harness=await createCodingHarness({workspace:root+'/repo',stateDirectory:root+'/state',storeBackend:'sqlite',subagentProfiles:[],modelInstance:model});
if(mode==='recover') await recoverHarnessLocalService(harness,root+'/transport');
const service=await startHarnessLocalService(harness,{directory:root+'/transport'});
const credentials=await readHarnessLocalCredentials(service.credentialsPath);const hello=await requestHarnessLocalService(credentials,'hello',{versions:[1]});let n=0;
const envelope=command=>({protocolVersion:1,requestId:'r'+(++n),connectionId:hello.connectionId,command:{...command,projectId:hello.projectId}});
const call=async command=>{const r=await requestHarnessLocalService(credentials,'command',envelope(command));if(!r.ok)throw Error(JSON.stringify(r));return r.data;};
try {
 if(mode==='crash'){
  const original=harness.store.completeToolExecution.bind(harness.store);
  harness.store.completeToolExecution=async(entry,options)=>{if(entry.toolName==='apply_reviewed_replacement'&&entry.status==='completed'){writeFileSync(root+'/effect.json',JSON.stringify({beforeJournalCommit:true}));process.kill(process.pid,'SIGKILL');await new Promise(()=>{});}return original(entry,options);};
  const session=(await call({method:'session.create',idempotencyKey:'create'})).session;
  const result=await call({method:'run.start',sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:'start',prompt:'Edit note'});
  const command={method:'approval.resolve',sessionId:session.sessionId,runId:result.run.runId,expectedRevision:result.run.revision,idempotencyKey:'approve',decisions:result.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))};
  writeFileSync(root+'/command.json',JSON.stringify(command));await service.dispatchReviewed(envelope(command));throw Error('Crash did not occur');
 }else{
  const old=JSON.parse(readFileSync(root+'/command.json','utf8'));const result=await call({method:'run.get',sessionId:old.sessionId,runId:old.runId,includeDiff:true});
  const replay=await service.dispatchReviewed(envelope({...old,idempotencyKey:'replay'}));
  console.log(JSON.stringify({decisions:result.run.decisions,replayAccepted:replay.ok,file:readFileSync(root+'/repo/note.txt','utf8')}));
 }
} finally {await service.close();}
