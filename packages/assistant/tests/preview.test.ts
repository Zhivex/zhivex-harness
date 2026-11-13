import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink,unlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createPreviewController} from '../src/preview/controller.js';

async function fixture(){
 const root=await mkdtemp('/tmp/assistant-preview-');const {execFileSync}=await import('node:child_process');execFileSync('git',['init','-q',root]);await writeFile(root+'/.gitignore','evidence/\n');await mkdir(root+'/web');await writeFile(root+'/web/index.html','<h1>Before</h1>');
 const options={directory:root+'/evidence',root:async(key:string)=>{if(!['a','b'].includes(key))throw Error('PROJECT_NOT_FOUND');return root;},allowed:()=>{}};
 const controller=await createPreviewController(options);
 const action=(action:string,extra:Record<string,unknown>={},projectKey='a')=>controller.action({action,projectKey,...extra}) as Promise<any>;
 return{root,controller,options,action,async close(){await controller.close();await rm(root,{recursive:true,force:true});}};
}

test('preview publication requires fresh single-use review and cannot expose symlinks or hidden files',async()=>{
 const f=await fixture();try{
  await writeFile(f.root+'/web/.secret','private');await writeFile(f.root+'/web/.env','TOKEN=private');
  const review=await f.action('review',{directory:'web'});expect(review.files).toEqual(['index.html']);
  await writeFile(f.root+'/web/index.html','<h1>After</h1>');
  await expect(f.action('start',{ticket:review.ticket})).rejects.toThrow('PREVIEW_REVIEW_CHANGED');
  const fresh=await f.action('review',{directory:'web'}),started=await f.action('start',{ticket:fresh.ticket}),p=started.previews[0];
  expect(await(await fetch(p.origin)).text()).toBe('<h1>After</h1>');
  expect((await fetch(p.origin+'/.env')).status).toBe(404);
  expect((await fetch(p.origin,{headers:{Host:'evil.invalid'}})).status).toBe(404);
  expect((await fetch(p.origin,{method:'POST'})).status).toBe(404);
  await expect(f.action('start',{ticket:fresh.ticket})).rejects.toThrow('PREVIEW_REVIEW_CHANGED');
  expect((await f.action('list',{},'b')).previews).toHaveLength(0);
  await symlink('/etc/passwd',f.root+'/web/leak.txt');await expect(f.action('review',{directory:'web'})).rejects.toThrow('PREVIEW_SYMLINK_REJECTED');
  await expect(f.action('review',{directory:'../web'})).rejects.toThrow();
  await f.action('stop');await expect(fetch(p.origin)).rejects.toThrow();
 }finally{await f.close();}
},15000);

test('browser evidence tests immutable bytes, blocks external requests, isolates tasks, survives restart and marks changed output stale',async()=>{
 const f=await fixture();let calls=0;const forbidden=createServer((_req,res)=>{calls++;res.end('privileged');});await new Promise<void>(r=>forbidden.listen(0,'127.0.0.1',r));
 const addr=forbidden.address();if(!addr||typeof addr==='string')throw Error('port');
 try{
  await writeFile(f.root+'/web/index.html',`<h1>After</h1><button onclick="document.querySelector('h1').textContent='Clicked'">Go</button><script>fetch('http://127.0.0.1:${addr.port}/api/workspace/preview',{method:'POST'}).catch(()=>{});</script>`);
  const review=await f.action('review',{directory:'web'}),{previews:[p]}=await f.action('start',{ticket:review.ticket});
  const request={origin:p.origin,previewId:p.id,digest:p.digest,plan:{path:'/',steps:[{kind:'click',selector:'button'},{kind:'text',selector:'h1',text:'Clicked'}]}};
  await expect(f.action('verify',{request},'b')).rejects.toThrow('PREVIEW_SCOPE_CHANGED');
  const verified=await f.action('verify',{request});expect(verified.status).toBe('passed');expect(calls).toBe(0);
  const artifact=await f.action('artifact',{id:verified.artifactId});expect(Buffer.from(artifact.screenshot,'base64').subarray(1,4).toString()).toBe('PNG');expect(artifact.plan).toEqual(request.plan);
  expect((await f.action('list')).artifacts[0].stale).toBe(false);
  await writeFile(f.root+'/source.ts','new source');expect((await f.action('list')).artifacts[0].stale).toBe(true);await unlink(f.root+'/source.ts');expect((await f.action('list')).artifacts[0].stale).toBe(false);
  await writeFile(f.root+'/web/index.html','<h1>New revision</h1>');expect((await f.action('list')).artifacts[0].stale).toBe(true);
  expect(await(await fetch(p.origin)).text()).toContain('After');
  const failed=await f.action('verify',{request:{...request,plan:{path:'/',steps:[{kind:'text',selector:'h1',text:'Not present'}]}}});expect(failed.status).toBe('failed');
  const feedback=await f.action('feedback',{id:artifact.id,digest:artifact.digest,text:'Adjust spacing'});expect((await f.action('artifact',{id:feedback.id})).feedback[0].id).toBe(artifact.id);
  await expect(f.action('artifact',{id:artifact.id},'b')).rejects.toThrow('ARTIFACT_NOT_FOUND');
  await f.controller.close();await expect(fetch(p.origin)).rejects.toThrow();
  const reopened=await createPreviewController(f.options);try{const list=await reopened.action({action:'list',projectKey:'a'}) as any;expect(list.previews).toHaveLength(0);expect(list.artifacts).toHaveLength(3);expect(list.artifacts.every((a:any)=>a.stale)).toBe(true);}finally{await reopened.close();}
 }finally{forbidden.closeAllConnections();await new Promise<void>(r=>forbidden.close(()=>r()));await f.close();}
},30000);

test('browser tool binding preserves legacy runtime approvals and persists only for new local runtimes',async()=>{
 const {previewToolsEnabled}=await import('../src/preview/binding.js');const f=await fixture();try{
  await mkdir(f.root+'/legacy');await writeFile(f.root+'/legacy/runtime.binding','legacy');
  expect(await previewToolsEnabled(f.root+'/legacy',true)).toBe(false);
  await mkdir(f.root+'/fresh');expect(await previewToolsEnabled(f.root+'/fresh',true)).toBe(true);await writeFile(f.root+'/fresh/runtime.binding','new');expect(await previewToolsEnabled(f.root+'/fresh',true)).toBe(true);expect(await previewToolsEnabled(f.root+'/fresh',false)).toBe(false);
 }finally{await f.close();}
});

test('Code composition pauses preview_verify for reviewed approval before creating browser evidence',async()=>{
 const {startAssistantHost}=await import('../src/host.js');const {createMockLanguageModel}=await import('@zhivex-ai/core/testing');const {execFileSync}=await import('node:child_process');const {randomUUID}=await import('node:crypto');
 const root=await mkdtemp('/tmp/preview-agent-');await mkdir(root+'/repo/web',{recursive:true});execFileSync('git',['init','-q',root+'/repo']);await writeFile(root+'/repo/web/index.html','<h1>Agent verified</h1>');
 const input={origin:'http://127.0.0.1:1',previewId:randomUUID(),digest:'0'.repeat(64),plan:{path:'/',steps:[{kind:'text',selector:'h1',text:'Agent verified'}]}};
 const model=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'browser',name:'preview_verify',input}},{type:'finish',finishReason:'tool-calls'}],[{type:'text-delta',textDelta:'Evidence ready'},{type:'finish',finishReason:'stop'}]]});
 const host=await startAssistantHost({directory:root+'/state',ownerId:'fixture',engine:{modelInstance:model},coding:{execution:'local',configurationId:'preview-agent'}});
 const app=host.application!;
 const unwrap=<T>(value:{ok:true;data:T}|{ok:false;error:unknown}):T=>{if(!value.ok)throw Error(JSON.stringify(value.error));return value.data;};
 try{
  const project=unwrap(await app.client.registerProject(await app.selectProject(root+'/repo'))),key=project.projectKey;
  const review=await app.previewAction({action:'review',projectKey:key,directory:'web'}) as any;
  const started=await app.previewAction({action:'start',projectKey:key,ticket:review.ticket}) as any;
  Object.assign(input,{origin:started.previews[0].origin,previewId:started.previews[0].id,digest:started.previews[0].digest});
  const conversation=unwrap(await app.client.createConversation({context:{kind:'project',projectKey:key},idempotencyKey:randomUUID()})),conversationId=conversation.conversationId;
  unwrap(await app.send({conversationId,prompt:'Verify the preview',key:randomUUID()}));
  const before=unwrap(await app.client.snapshot(conversationId)),run=before.runs[0]!;expect(run.status).toBe('waiting_approval');
  expect((await app.previewAction({action:'list',projectKey:key}) as any).artifacts).toHaveLength(0);
  const ticket=unwrap(await app.client.review({conversationId,target:{kind:'effect',runId:run.runId}}));
  expect(JSON.stringify(ticket)).toContain('preview_verify');expect(JSON.stringify(ticket)).toContain(input.previewId);
  const decision=unwrap(await app.client.decide({conversationId,ticketId:ticket.ticketId,approve:true,idempotencyKey:randomUUID()}));expect(decision.ok).toBe(true);
  const after=await app.previewAction({action:'list',projectKey:key}) as any;expect(after.agentVerification).toBe(true);expect(after.artifacts).toHaveLength(1);expect(after.artifacts[0].status).toBe('passed');
 }finally{await host.close();await rm(root,{recursive:true,force:true});}
},30000);

test('agent cancellation closes an active browser and persists failed evidence without replay',async()=>{
 const f=await fixture();try{
  const review=await f.action('review',{directory:'web'}),{previews:[p]}=await f.action('start',{ticket:review.ticket}),abort=new AbortController();
  const client=f.controller.mcp('a').mcpClients!.preview!;
  const pending=client.callTool({name:'verify',arguments:{origin:p.origin,previewId:p.id,digest:p.digest,plan:{path:'/',steps:[{kind:'text',selector:'#never-appears',text:'missing'}]}}},{abortSignal:abort.signal});
  const timer=setTimeout(()=>abort.abort(),200);try{await pending;}finally{clearTimeout(timer);}
  const artifacts=(await f.action('list')).artifacts;expect(artifacts).toHaveLength(1);expect(artifacts[0]).toMatchObject({status:'failed',error:'PREVIEW_CANCELLED'});
 }finally{await f.close();}
},15000);
