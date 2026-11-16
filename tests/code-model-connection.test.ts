import {createHash} from 'node:crypto';
import {test, expect} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {createCodeProjects} from '../packages/core/src/application/code/projects.js';
import {connectApplication} from '../packages/core/src/application/client.js';

test('project connection changes preserve sessions, reject pending work and restore old host after save failure', async () => {
 const directory = await mkdtemp('/tmp/code-model-'); execFileSync('git',['-C',directory,'init','-q']);
 await writeFile(directory+'/a.txt','before\n'); let saved: unknown, fail = false;
 const projects = createCodeProjects({directory:directory+'/transport',read:()=>saved,save:value=>{if(fail) throw new Error('SAVE_FAILED'); saved=structuredClone(value);},connection:id=>{
  if(!['one','two'].includes(id)) throw new Error('CONNECTION_MISSING');
  return {engine:{modelInstance:createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'a.txt',expectedDigest:'sha256:'+createHash('sha256').update('before\n').digest('hex'),oldText:'before',newText:'after'}}},{type:'finish',finishReason:'tool-calls'}]]}),model:id,subagentProfiles:[]}};
 }});
 try {
  await projects.open(directory,'one'); const id=projects.state().active!;
  let client=await connectApplication(projects.currentHost()!.credentialsPath); const projectId=client.projectId;
  const result=await client.command({method:'session.create',idempotencyKey:'s',title:'Preserved'}); if(!result.ok || result.data.kind!=='session') throw new Error('session');
  const session=result.data.session;
  await expect(projects.configure(id,'missing')).rejects.toThrow('CONNECTION_MISSING');
  fail=true; await expect(projects.configure(id,'two')).rejects.toThrow('SAVE_FAILED'); fail=false;
  expect(projects.state().projects[0]?.connectionId).toBe('one'); expect(projects.state().ready).toBe(true);
  await projects.configure(id,'two'); client=await connectApplication(projects.currentHost()!.credentialsPath);
  expect(client.projectId).toBe(projectId); expect(projects.state().projects[0]?.connectionId).toBe('two');
  expect(await client.command({method:'session.list'})).toMatchObject({ok:true,data:{sessions:[{title:'Preserved'}]}});
  const run=await client.command({method:'run.start',sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:'r',prompt:'edit'});
  expect(run).toMatchObject({ok:true,data:{run:{status:'waiting_approval'}}});
  await expect(projects.configure(id,'one')).rejects.toThrow('CODE_PROJECT_BUSY');
  expect(projects.state().projects[0]?.connectionId).toBe('two');
 } finally {await projects.close();await rm(directory,{recursive:true,force:true});}
});
