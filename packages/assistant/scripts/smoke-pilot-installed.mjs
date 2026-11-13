/** Run with the packaged Node and an installed runtime outside the checkout. No real provider or user state. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const runtime=path.resolve(process.argv[2]);
assert.equal(process.execPath,runtime+'/node');
const integrity=JSON.parse(execFileSync(process.execPath,[runtime+'/dist/pilot/cli.js','verify','--runtime',runtime],{encoding:'utf8'}));assert.equal(integrity.integrity,'matched');
const {startAssistantHost,connectAssistant}=await import(pathToFileURL(runtime+'/dist/index.js'));
const {createMockLanguageModel}=await import(pathToFileURL(runtime+'/node_modules/@zhivex-ai/core/dist/testing.js'));
const {AsyncEntry}=await import(pathToFileURL(runtime+'/node_modules/@napi-rs/keyring/index.js'));
const entry=new AsyncEntry('ai.zhivex.assistant.pilot-fixture',randomUUID()),value=randomUUID();let keychainWritten=false;
const root=await mkdtemp('/tmp/installed-pilot-fixture-');let host;
const unwrap=v=>{assert.equal(v.ok,true,JSON.stringify(v));return v.data;};
try{
 await entry.setPassword(value,AbortSignal.timeout(10000));keychainWritten=true;assert.equal(await entry.getPassword(AbortSignal.timeout(10000)),value);await entry.deletePassword(AbortSignal.timeout(10000));keychainWritten=false;
 const repo=root+'/repo';await mkdir(repo);execFileSync('git',['init','-q',repo]);await writeFile(repo+'/answer.txt','BEFORE\n');
 const script=`node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'AFTER\\n')"`;await writeFile(repo+'/package.json',JSON.stringify({scripts:{test:script}}));
 const model=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'answer.txt',expectedDigest:'sha256:'+createHash('sha256').update('BEFORE\n').digest('hex'),oldText:'BEFORE',newText:'AFTER'}}},{type:'finish',finishReason:'tool-calls'}],[{type:'tool-call',toolCall:{id:'check',name:'run_check',input:{check:'test',expectedScript:script}}},{type:'finish',finishReason:'tool-calls'}],[{type:'text-delta',textDelta:'Checked.'},{type:'finish',finishReason:'stop'}]]});
 const options={directory:root+'/state',ownerId:'fixture',engine:{modelInstance:model},coding:{execution:'local',configurationId:'installed-pilot-v1'}};
 host=await startAssistantHost(options);let app=host.application;const project=unwrap(await app.client.registerProject(await app.selectProject(repo))),projectKey=project.projectKey;
 const c=unwrap(await app.client.createConversation({context:{kind:'project',projectKey},idempotencyKey:randomUUID()})),conversationId=c.conversationId;
 unwrap(await app.send({conversationId,prompt:'Update the fixture and check it.',key:randomUUID()}));let snapshot=unwrap(await app.client.snapshot(conversationId));const runId=snapshot.runs[0].runId;assert.equal(snapshot.runs[0].status,'waiting_approval');assert.equal(await readFile(repo+'/answer.txt','utf8'),'BEFORE\n');
 await host.close();host=await startAssistantHost(options);app=host.application;snapshot=unwrap(await app.client.snapshot(conversationId));assert.equal(snapshot.runs[0].status,'waiting_approval');assert.equal(await readFile(repo+'/answer.txt','utf8'),'BEFORE\n');
 for(let i=0;i<2;i++){const ticket=unwrap(await app.client.review({conversationId,target:{kind:'effect',runId}}));assert.equal(ticket.preview.review.canApprove,true);unwrap(unwrap(await app.client.decide({conversationId,ticketId:ticket.ticketId,approve:true,idempotencyKey:randomUUID()})));}
 assert.equal(await readFile(repo+'/answer.txt','utf8'),'AFTER\n');assert.equal(unwrap(await app.client.snapshot(conversationId)).runs[0].status,'completed');assert.ok((await app.outputs({conversationId,runId})).some(o=>o.exitCode===0));
 const connection=await app.projectConnection(projectKey),client=await connectAssistant(connection.credentialsPath);assert.equal((await client.command({method:'session.list'})).ok,true);
 await mkdir(repo+'/dist');await writeFile(repo+'/dist/index.html','<h1>Installed pilot</h1>');const action=(action,extra={})=>app.previewAction({action,projectKey,...extra});const review=await action('review',{directory:'dist'}),{previews:[p]}=await action('start',{ticket:review.ticket});
 const checked=await action('verify',{request:{origin:p.origin,previewId:p.id,digest:p.digest,plan:{path:'/',steps:[{kind:'text',selector:'h1',text:'Installed pilot'}]}}});assert.equal(checked.status,'passed');
 await host.close();host=undefined;await assert.rejects(fetch(p.origin));
 console.log(JSON.stringify({gate:'installed-macos-pilot',status:'passed',provider:'offline-mock',keychain:'real-temporary-entry-removed',history:'approval survived restart without replay',coding:'reviewed edit and successful check',compatibility:'public Code service attachment',preview:'real Chromium and bundled worker',shutdown:'preview port closed',integrityFiles:integrity.files}));
}finally{await host?.close();if(keychainWritten)await entry.deletePassword(AbortSignal.timeout(10000));await rm(root,{recursive:true,force:true});}
