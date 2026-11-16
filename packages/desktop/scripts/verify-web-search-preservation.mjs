import {mkdtemp,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const installed=JSON.parse(await readFile(root+'/packages/desktop/.harness/installed.json','utf8'));
const core=installed.install+'/node_modules/@zhivex-ai/harness/dist/engine/assistant';
const {startManagedAssistant}=await import(core+'/managed/setup.js');
const {connectAssistant}=await import(core+'/client.js');
let stored=null;
const directory=await mkdtemp('/tmp/zhivex-web-preservation-');
const setup=await startManagedAssistant(directory,{secrets:{read:async()=>stored,write:async value=>{stored=value;}},validateProvider:async()=>{}});
try {
 await setup.action('begin',{});
 await setup.action('provider',{baseURL:'https://api.openai.com/v1',apiKey:'fixture-not-a-real-key',model:'test-model',apiMode:'chat'});
 await setup.action('start',{});
 const before=setup.state(); const profile=before.profiles.find(p=>p.active);
 let client=await connectAssistant(setup.currentHost().credentialsPath);
 const created=await client.command({method:'session.create',title:'Preserve this chat',idempotencyKey:crypto.randomUUID()});
 assert.equal(created.ok,true);
 const id=created.data.session.sessionId;
 for(const enabled of [true,false]) {
  await setup.action('agent-update',{id:profile.id,name:profile.name,model:profile.provider.model,connectionId:profile.connectionId,webSearch:enabled});
  const state=setup.state(); assert.equal(state.profiles.length,before.profiles.length);
  assert.equal(state.profiles.find(p=>p.active).id,profile.id);
  assert.equal(state.profiles.find(p=>p.active).provider.webSearch,enabled);
  client=await connectAssistant(setup.currentHost().credentialsPath);
  const listed=await client.command({method:'session.list'});
  assert.equal(listed.ok,true); assert.ok(listed.data.sessions.some(s=>s.sessionId===id && s.title==='Preserve this chat'));
 }
 console.log('PASS: enabling and disabling web search retains the same assistant and saved chat. No external provider calls.');
} finally {await setup.close();}
