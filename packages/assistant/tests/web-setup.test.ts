import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant, testProvider } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';

const provider = { baseURL: 'https://example.test/v1', model: 'test', apiKey: 'private-model-key', apiMode: 'chat' as const, allowInsecureLocalhost: false };
for (const provider of [
  { baseURL: 'https://example.test/v1', model: 'test', apiKey: 'private-model-key', apiMode: 'chat' as const, allowInsecureLocalhost: false },
  { kind: 'meta' as const, model: 'muse-spark-1.3', apiKey: 'private-meta-key' },
  { kind: 'qwen' as const, service: 'qwencloud' as const, model: 'qwen3.8-flash', apiKey: 'private-cloud-key' },
  { kind: 'qwen' as const, model: 'qwen3.6-plus', apiKey: 'private-qwen-key', region: 'singapore' as const }
]) test(`setup ${provider.kind ?? 'compatible'} protects mutations, persists secrets and restores conversations`, async () => {
  const directory = await mkdtemp('/tmp/assistant-setup-');
  await mkdir(directory+'/assets'); await writeFile(directory+'/assets/index.html','Assistant');
  let stored: string | null = null, validations=0;
  const secrets = { async read(){return stored;}, async write(value:string){stored=value;} };
  const options = { assetsDirectory: directory+'/assets', secrets, validateProvider: async()=>{validations++;},
    startHost: async (input: Parameters<typeof startAssistantHost>[0]) => startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'Hello'},{type:'finish',finishReason:'stop'}]]})}}) };
  let app = await startManagedAssistant(directory+'/runtime',options);
  const connection = () => { const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};return {headers,post:(route:string,value:unknown={})=>fetch(app.origin+'/api/'+route,{method:'POST',headers,body:JSON.stringify(value)}),get:(route:string)=>fetch(app.origin+'/api/'+route,{headers})}; };
  try {
    let client=connection();
    expect((await fetch(app.origin+'/api/setup')).status).toBe(401);
    expect((await fetch(app.origin+'/api/setup/begin',{method:'POST',headers:{...client.headers,origin:'https://evil.test'},body:'{}'})).status).toBe(403);
    expect(await (await client.get('setup')).json()).toMatchObject({ready:false,locked:false});
    expect(await (await client.get('state')).json()).toEqual({error:'SETUP_REQUIRED'});
    await expect(startManagedAssistant(directory+'/runtime',options)).rejects.toThrow('SETUP_ALREADY_RUNNING');
    expect((await client.post('setup/begin')).status).toBe(200);
    expect((await client.post('setup/provider',provider)).status).toBe(200);expect(validations).toBe(1);
    expect(JSON.stringify(await (await client.get('setup')).json())).not.toContain(provider.apiKey);
    expect(String(stored)).toContain(provider.apiKey);expect(JSON.parse(stored!).draft.provider.apiKey).toBeUndefined();
    if (provider.kind) {
      expect(JSON.parse(stored!).draft.provider.kind).toBe(provider.kind);
      expect((await (await client.get('setup')).json() as any).provider).toMatchObject({kind:provider.kind,canEnableWebSearch:false});
    }
    expect((await client.post('setup/start')).status).toBe(200);
    expect((await client.post('message',{prompt:'Hello',key:randomUUID()})).status).toBe(200);
    const state=await (await client.get('state')).json() as any;expect(state.sessions).toHaveLength(1);
    const priorToken=client.headers.authorization;
    await app.close(); app=await startManagedAssistant(directory+'/runtime',options);client=connection();
    expect((await fetch(app.origin+'/api/setup',{headers:{authorization:priorToken}})).status).toBe(401);
    expect((await (await client.get('state')).json() as any).sessions[0].sessionId).toBe(state.sessions[0].sessionId);
    const first=(await (await client.get('setup')).json() as any).profiles[0].id;
    await client.post('setup/begin'); await client.post('setup/provider',provider);await client.post('setup/start');
    expect((await (await client.get('state')).json() as any).sessions).toHaveLength(0);
    expect((await client.post('setup/select',{id:first})).status).toBe(200);
    expect((await (await client.get('state')).json() as any).sessions[0].sessionId).toBe(state.sessions[0].sessionId);
  } finally {await app.close();await rm(directory,{recursive:true,force:true});}
},30000);

test('keychain failure remains recoverable in web without saving a plaintext fallback',async()=>{
  const directory=await mkdtemp('/tmp/assistant-keychain-');await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  let locked=true;
  const app=await startManagedAssistant(directory+'/runtime',{assetsDirectory:directory+'/assets',secrets:{async read(){if(locked)throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');return null;},async write(){throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');}}});
  const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};
  try {
    expect(await (await fetch(app.origin+'/api/setup',{headers})).json()).toMatchObject({locked:true,error:'SETUP_KEYCHAIN_UNAVAILABLE'});
    locked=false;
    expect(await (await fetch(app.origin+'/api/setup/retry',{method:'POST',headers,body:'{}'})).json()).toMatchObject({locked:false,ready:false});
    expect((await fetch(app.origin+'/api/setup/begin',{method:'POST',headers,body:'{}'})).status).toBe(400);
    expect(await (await fetch(app.origin+'/api/setup',{headers})).json()).toMatchObject({editing:false});
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('provider access probe validates protocol and sanitizes remote failures',async()=>{
  const request: typeof fetch = Object.assign(async(_url:unknown, init?:RequestInit)=>{expect(init?.redirect).toBe('error');expect(init?.body).toContain('Reply only OK');return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}));}, {preconnect:fetch.preconnect});
  await testProvider(provider,request);
  const failure: typeof fetch=Object.assign(async()=>new Response('secret upstream details',{status:401}),{preconnect:fetch.preconnect});
  await expect(testProvider(provider,failure)).rejects.toThrow('SETUP_PROVIDER_AUTH');
  await expect(testProvider({...provider,baseURL:'http://remote.test/v1'},request)).rejects.toThrow('ASSISTANT_PROVIDER_CONFIG_INVALID');
});

test('web OAuth and Telegram pairing require consent and local confirmation without returning secrets',async()=>{
  const directory=await mkdtemp('/tmp/assistant-integrations-');await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  let stored:string|null=null, pairingCode='', updates:unknown[]=[];
  const integrationFetch:typeof fetch=Object.assign(async(input:unknown)=>{
    const url=String(input);
    if(url.includes('oauth2.googleapis.com/token'))return Response.json({token_type:'Bearer',access_token:'access-private',refresh_token:'refresh-private',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.events'});
    if(url.includes('/userinfo'))return Response.json({sub:'account',email:'owner@example.test',email_verified:true});
    if(url.endsWith('/getMe'))return Response.json({ok:true,result:{id:99,is_bot:true,username:'assistant_test_bot'}});
    if(url.endsWith('/getWebhookInfo'))return Response.json({ok:true,result:{url:''}});
    if(url.endsWith('/getUpdates'))return Response.json({ok:true,result:updates});
    throw new Error('unexpected external request');
  },{preconnect:fetch.preconnect});
  const app=await startManagedAssistant(directory+'/runtime',{assetsDirectory:directory+'/assets',integrationFetch,secrets:{async read(){return stored;},async write(value){stored=value;}}});
  const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};
  const post=(name:string,body:unknown={})=>fetch(app.origin+'/api/setup/'+name,{method:'POST',headers,body:JSON.stringify(body)});
  const get=async()=>await (await fetch(app.origin+'/api/setup',{headers})).json() as any;
  try {
    await post('begin');
    const begun=await (await post('calendar',{clientId:'app.apps.googleusercontent.com'})).json() as any;
    const auth=new URL(begun.authorizationUrl);expect(auth.hostname).toBe('accounts.google.com');expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await post('start')).status).toBe(400);
    expect(await get()).toMatchObject({calendar:{connected:false,pending:true}});
    const callback=new URL(auth.searchParams.get('redirect_uri')!);callback.searchParams.set('code','test-code');callback.searchParams.set('state',auth.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    for(let i=0;i<50 && !(await get()).calendar.connected;i++)await new Promise(r=>setTimeout(r,10));
    expect(await get()).toMatchObject({calendar:{connected:true,email:'owner@example.test'}});
    const botToken='123:'+ 't'.repeat(30);
    const telegram=await (await post('telegram',{token:botToken})).json() as any;
    pairingCode=new URL(telegram.telegram.url).searchParams.get('start')!;
    updates=[{update_id:1,message:{message_id:1,from:{id:7},chat:{id:7,type:'group'},text:`/start ${pairingCode}`}}];
    expect(await (await post('telegram-check')).json()).not.toHaveProperty('telegram.candidate');
    updates=[{update_id:2,message:{message_id:2,from:{id:7},chat:{id:7,type:'private'},text:`/start ${pairingCode}`}}];
    expect(await (await post('telegram-check')).json()).toMatchObject({telegram:{candidate:'7',configured:false}});
    expect((await post('telegram-confirm',{userId:'8'})).status).toBe(400);
    expect(await (await post('telegram-confirm',{userId:'7'})).json()).toMatchObject({telegram:{configured:true}});
    const publicState=JSON.stringify(await get());expect(publicState).not.toContain(botToken);expect(publicState).not.toContain('refresh-private');expect(publicState).not.toContain('encryptionKey');
    const data=JSON.parse(stored!);const sqlite=await readFile(directory+'/runtime/'+data.draft.id+'/state/calendar.sqlite');expect(sqlite.toString()).not.toContain('refresh-private');
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
},15000);

test('changing configuration is blocked while an exact approval is pending, and cancellation remains available',async()=>{
  const { GENERAL_ASSISTANT_PROFILE }=await import('@zhivex-ai/harness/engine');
  const { createHash }=await import('node:crypto');
  const directory=await mkdtemp('/tmp/assistant-pending-');await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  let stored:string|null=null;
  const app=await startManagedAssistant(directory+'/runtime',{assetsDirectory:directory+'/assets',secrets:{async read(){return stored;},async write(value){stored=value;}},validateProvider:async()=>{},startHost:async input=>{
    await mkdir(input.directory+'/workspace',{recursive:true,mode:0o700});await writeFile(input.directory+'/workspace/note.txt','before');
    return startAssistantHost({...input,engine:{modelInstance:createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_replacement',input:{path:'note.txt',expectedDigest:'sha256:'+createHash('sha256').update('before').digest('hex'),oldText:'before',newText:'after'}}},{type:'finish',finishReason:'tool-calls'}]]}),agentProfile:{...GENERAL_ASSISTANT_PROFILE,toolNames:['apply_reviewed_replacement']}}});
  }});
  const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};
  const post=(name:string,body:unknown={})=>fetch(app.origin+'/api/'+name,{method:'POST',headers,body:JSON.stringify(body)});
  try{
    await post('setup/begin');await post('setup/provider',provider);await post('setup/start');
    expect((await post('message',{prompt:'Edit note',key:randomUUID()})).status).toBe(200);
    const snapshot=await (await fetch(app.origin+'/api/state',{headers})).json() as any;
    expect(snapshot.sessions[0].runs[0].status).toBe('waiting_approval');
    const active=(await (await fetch(app.origin+'/api/setup',{headers})).json() as any).profiles[0].id;
    expect(await (await post('setup/delete-agent',{id:active})).json()).toEqual({error:'SETUP_PENDING_RUNS'});
    expect(await (await post('setup/agent-connection',{id:active,connectionId:'any'})).json()).toEqual({error:'SETUP_PENDING_RUNS'});

    expect(await (await post('setup/begin')).json()).toEqual({error:'SETUP_PENDING_RUNS'});
    expect((await post('cancel',{sessionId:snapshot.sessions[0].sessionId,runId:snapshot.sessions[0].runs[0].runId,key:randomUUID()})).status).toBe(200);
    expect((await post('setup/begin')).status).toBe(200);
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
},15000);

test('locally confirmed Telegram owner starts linked and skips setup updates without sending a message',async()=>{
  const { createTelegramBridge }=await import('../src/telegram/bridge.js');
  const directory=await mkdtemp('/tmp/assistant-confirmed-');
  const host=await startAssistantHost({directory,ownerId:'owner',engine:{modelInstance:createMockLanguageModel({streamEvents:[[{type:'finish',finishReason:'stop'}]]})}});
  let sends=0;
  const api={async call(method:string){if(method==='getMe')return{id:9,is_bot:true};if(method==='getWebhookInfo')return{url:''};sends++;throw new Error('Unexpected call');}};
  let bridge:Awaited<ReturnType<typeof createTelegramBridge>>|undefined;
  try{
    await expect(createTelegramBridge({stateDirectory:directory+'/state',credentialsPath:host.credentialsPath,ownerId:'owner',expectedTelegramUserId:'7',confirmedPrivateChatId:'8',confirmedUpdateOffset:5,api})).rejects.toThrow('TELEGRAM_OWNER_INVALID');
    bridge=await createTelegramBridge({stateDirectory:directory+'/state',credentialsPath:host.credentialsPath,ownerId:'owner',expectedTelegramUserId:'7',confirmedPrivateChatId:'7',confirmedUpdateOffset:5,api});
    expect(bridge.diagnostics()).toMatchObject({linked:true,offset:5});expect(bridge.pairingCode).toBeUndefined();expect(sends).toBe(0);
  }finally{await bridge?.close();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('existing OpenAI configuration enables search without returning or reentering its key', async () => {
  const directory=await mkdtemp('/tmp/assistant-search-');
  await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  const old={id:'0123456789ab',name:'Original',provider:{...provider,baseURL:'https://api.openai.com/v1'}};
  let stored=JSON.stringify({version:1,active:old.id,profiles:[old]});
  let validated:any;
  const app=await startManagedAssistant(directory+'/runtime',{assetsDirectory:directory+'/assets',secrets:{async read(){return stored;},async write(value){stored=value;}},validateProvider:async value=>{validated=value;},startHost:async input=>startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel({streamEvents:[]})}})});
  const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};
  const post=(route:string)=>fetch(app.origin+'/api/setup/'+route,{method:'POST',headers,body:'{}'});
  try {
    const response=await post('enable-web-search');expect(response.status).toBe(200);
    const state=await response.json() as any;
    expect(state.provider).toMatchObject({webSearch:true});expect(JSON.stringify(state)).not.toContain(provider.apiKey);
    expect(validated).toMatchObject({apiKey:provider.apiKey,apiMode:'responses',webSearch:true});
    const saved=JSON.parse(stored);expect(saved.profiles[0]).toMatchObject({id:old.id,name:old.name,provider:{model:old.provider.model}});expect(saved.profiles[0].provider.apiKey).toBeUndefined();expect(saved.active).toBe(old.id);expect(saved.draft.id).not.toBe(old.id);
    expect((await post('start')).status).toBe(200);
    expect(JSON.parse(stored).profiles).toHaveLength(2);
  } finally {await app.close();await rm(directory,{recursive:true,force:true});}
});

test('search onboarding probe sends hosted tool and reports unsupported models safely', async () => {
  const value={...provider,baseURL:'https://api.openai.com/v1',apiMode:'responses' as const,webSearch:true as const};
  const fetcher=(async (_:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body)).tools).toEqual([{type:'web_search'}]);return Response.json({output:[]});}) as typeof fetch;
  await testProvider(value,fetcher);
  await expect(testProvider(value,Object.assign(async()=>new Response('private details',{status:400}),{preconnect:fetch.preconnect}))).rejects.toThrow('SETUP_WEB_SEARCH_UNSUPPORTED');
});

test('named agents keep different providers and histories across selection, failure and restart', async () => {
  const directory = await mkdtemp('/tmp/assistant-agents-');
  await mkdir(directory+'/assets'); await writeFile(directory+'/assets/index.html','Assistant');
  let stored: string | null = null, failModel = '';
  const bindings: string[] = [];
  const options = {
    assetsDirectory: directory+'/assets',
    secrets: { async read(){return stored;}, async write(value:string){stored=value;} },
    validateProvider: async()=>{},
    startHost: async(input: Parameters<typeof startAssistantHost>[0]) => {
      bindings.push(input.engine!.model!);
      if (input.engine?.model === failModel) throw new Error('SETUP_PROVIDER_UNREACHABLE');
      return startAssistantHost({...input, engine:{...input.engine, modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:input.engine!.model!},{type:'finish',finishReason:'stop'}]]})}});
    }
  };
  let app = await startManagedAssistant(directory+'/runtime',options);
  const request = async(route:string, body?:unknown) => {
    const headers={authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'};
    return fetch(app.origin+'/api/'+route,{headers,...(body ? {method:'POST',body:JSON.stringify(body)} : {})});
  };
  const get = async(route:string) => await (await request(route)).json() as any;
  try {
    await request('setup/begin',{name:'Nombre inicial'});
    await request('setup/provider',provider);
    expect((await request('setup/start',{name:'   '})).status).toBe(400);
    expect((await get('setup')).draftName).toBe('Nombre inicial');
    expect((await request('setup/start',{name:'Escritor'})).status).toBe(200);
    const first = (await get('setup')).profiles[0].id;
    await request('message',{prompt:'Hello',key:randomUUID()});
    const firstSession = (await get('state')).sessions[0].sessionId;
    await request('setup/begin',{name:'Investigador'});
    await request('setup/provider',{kind:'qwen',model:'qwen3.8-flash',apiKey:'other-private-key'});
    expect((await request('setup/rename',{name:'   '})).status).toBe(400);
    expect((await request('setup/select',{id:first})).status).toBe(400);
    failModel='qwen3.8-flash';
    expect((await request('setup/start',{})).status).toBe(400);
    expect((await get('state')).sessions[0].sessionId).toBe(firstSession);
    expect(await get('setup')).toMatchObject({ready:true,editing:true});
    failModel='';
    expect((await request('setup/start',{})).status).toBe(200);
    const state=await get('setup');
    expect(state.profiles).toMatchObject([
      {id:first,name:'Escritor',active:false,provider:{kind:'openai-compatible',model:'test'}},
      {name:'Investigador',active:true,provider:{kind:'qwen',model:'qwen3.8-flash'}}
    ]);
    expect(JSON.stringify(state)).not.toContain('private-key');
    expect((await get('state')).sessions).toHaveLength(0);
    await request('setup/rename',{id:first,name:'Redactor'});
    const second=state.profiles[1].id;
    await request('message',{prompt:'Hello again',key:randomUUID()});
    const secondSession=(await get('state')).sessions[0].sessionId;
    expect((await request('setup/model',{id:second,model:'qwen-next'})).status).toBe(200);
    expect((await get('state')).sessions[0].sessionId).toBe(secondSession);
    expect(bindings.at(-1)).toBe('qwen-next');
    expect((await request('message',{prompt:'Continue',sessionId:secondSession,key:randomUUID()})).status).toBe(200);
    expect((await get('state')).sessions[0].runs.at(-1).output).toBe('qwen-next');
    failModel='broken-model';
    expect((await request('setup/model',{id:second,model:failModel})).status).toBe(400);
    expect((await get('setup')).provider.model).toBe('qwen-next');
    expect((await get('state')).sessions[0].sessionId).toBe(secondSession);
    failModel='';
    const connection=(await get('setup')).connections.find((c:any)=>c.kind==='qwen');
    expect(JSON.stringify(connection)).not.toContain('other-private-key');
    await request('setup/begin',{name:'Otro Qwen'});
    expect((await request('setup/reuse-provider',{id:connection.id,model:'qwen-third'})).status).toBe(200);
    const persisted=JSON.parse(stored!);
    expect(persisted.version).toBe(2);
    expect(persisted.connections).toHaveLength(2);
    expect(persisted.profiles[1].provider.connectionId).toBe(persisted.draft.provider.connectionId);
    expect(persisted.draft.provider.apiKey).toBeUndefined();
    expect((await request('setup/discard',{})).status).toBe(200);

    await app.close();app=await startManagedAssistant(directory+'/runtime',options);
    expect((await get('setup')).profiles[1].active).toBe(true);expect((await get('setup')).provider.model).toBe('qwen-next');expect((await get('state')).sessions[0].sessionId).toBe(secondSession);
    expect((await request('setup/select',{id:first})).status).toBe(200);
    expect((await get('state')).sessions[0].sessionId).toBe(firstSession);
    expect((await get('setup')).profiles[0].name).toBe('Redactor');
    expect(bindings).toContain('qwen3.8-flash');
    expect(bindings.at(-1)).toBe('test');
  } finally {await app.close();await rm(directory,{recursive:true,force:true});}
},30000);

test('connection key rotation updates all references atomically and survives restart', async()=>{
  const directory=await mkdtemp('/tmp/assistant-key-rotation-');
  await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  const first={id:'111111111111',name:'First',provider};
  const second={id:'222222222222',name:'Second',provider:{...provider,model:'second-model'}};
  const other={id:'333333333333',name:'Other',provider:{...provider,apiKey:'unrelated-key'}};
  let stored=JSON.stringify({version:1,active:first.id,profiles:[first,second,other]});
  let failWrite=false, failStart=false;
  const probes: {model:string;apiKey:string}[]=[];
  const options={assetsDirectory:directory+'/assets',
    secrets:{async read(){return stored;},async write(value:string){if(failWrite)throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');stored=value;}},
    validateProvider:async(value:Parameters<typeof testProvider>[0])=>{probes.push(value);if(value.apiKey==='rejected-key' && value.model==='second-model')throw new Error('SETUP_PROVIDER_AUTH');},
    startHost:async(input:Parameters<typeof startAssistantHost>[0])=>{if(failStart){failStart=false;throw new Error('SETUP_FAILED');}return startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'OK'},{type:'finish',finishReason:'stop'}]]})}});}};
  let app=await startManagedAssistant(directory+'/runtime',options);
  const request=async(route:string,body?:unknown)=>fetch(app.origin+'/api/'+route,{headers:{authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const get=async(route:string)=>await(await request(route)).json() as any;
  try{
    const connection=(await get('setup')).connections.find((c:any)=>c.agents.length===2);
    await request('message',{prompt:'Hi',key:randomUUID()});
    const sessionId=(await get('state')).sessions[0].sessionId;
    await request('setup/begin',{});await request('setup/reuse-provider',{id:connection.id,model:'draft-model'});
    const original=stored;
    for(const failure of ['probe','storage','start']){
      failWrite=failure==='storage';failStart=failure==='start';
      expect((await request('setup/connection-key',{id:connection.id,apiKey:failure==='probe'?'rejected-key':'replacement-key'})).status).toBe(400);
      expect(stored).toBe(original);expect((await get('setup')).ready).toBe(true);
      expect((await get('state')).sessions[0].sessionId).toBe(sessionId);
      failWrite=false;
    }
    probes.length=0;
    const result=await request('setup/connection-key',{id:connection.id,apiKey:'replacement-key'});
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).not.toContain('replacement-key');
    expect(probes.map(p=>p.model).sort()).toEqual(['draft-model','second-model','test']);
    expect(probes.every(p=>p.apiKey==='replacement-key')).toBe(true);
    const data=JSON.parse(stored);
    expect(data.connections).toHaveLength(2);
    expect(data.connections.find((c:any)=>c.id===connection.id).apiKey).toBe('replacement-key');
    expect(data.connections.some((c:any)=>c.apiKey==='unrelated-key')).toBe(true);
    expect(data.profiles.slice(0,2).every((p:any)=>p.provider.connectionId===connection.id && !p.provider.apiKey)).toBe(true);
    expect(data.draft.provider.connectionId).toBe(connection.id);
    expect(stored).not.toContain('private-model-key');
    await request('setup/discard',{});
    await app.close();app=await startManagedAssistant(directory+'/runtime',options);
    expect((await get('setup')).connections.find((c:any)=>c.id===connection.id).agents).toHaveLength(2);
    expect((await get('state')).sessions[0].sessionId).toBe(sessionId);
    expect((await request('setup/select',{id:second.id})).status).toBe(200);
    expect((await request('setup/connection-key',{id:'missing',apiKey:'key'})).status).toBe(400);
    expect(await get('setup')).toMatchObject({ready:true,error:null});
    expect(await (await request('setup/delete-agent',{id:'missing'})).json()).toEqual({error:'SETUP_AGENT_NOT_FOUND'});
    expect(await get('setup')).toMatchObject({ready:true,error:null});
    expect(await (await request('setup/delete-connection',{id:connection.id})).json()).toEqual({error:'SETUP_CONNECTION_IN_USE'});
    failWrite=true;
    expect((await request('setup/delete-agent',{id:second.id})).status).toBe(400);
    expect((await get('setup')).ready).toBe(true);
    expect((await get('setup')).profiles).toHaveLength(3);
    failWrite=false;
    expect((await request('setup/delete-agent',{id:first.id})).status).toBe(200);
    await expect(readFile(directory+'/runtime/'+first.id+'/state/host.json')).rejects.toThrow();
    expect((await request('setup/delete-connection',{id:connection.id})).status).toBe(400);
    expect((await request('setup/delete-agent',{id:second.id})).status).toBe(200);
    expect((await get('setup')).ready).toBe(false);
    expect((await get('setup')).profiles).toHaveLength(1);
    await app.close();app=await startManagedAssistant(directory+'/runtime',options);
    expect((await get('setup')).connections.find((c:any)=>c.id===connection.id).agents).toHaveLength(0);
    await request('setup/begin',{});
    expect((await request('setup/reuse-provider',{id:connection.id})).status).toBe(200);
    expect((await request('setup/delete-connection',{id:connection.id})).status).toBe(400);
    await request('setup/discard',{});
    failWrite=true;
    expect((await request('setup/delete-connection',{id:connection.id})).status).toBe(400);
    failWrite=false;
    expect((await request('setup/delete-connection',{id:connection.id})).status).toBe(200);
    expect(JSON.parse(stored).connections).toHaveLength(1);
    expect(stored).not.toContain('replacement-key');
    await app.close();app=await startManagedAssistant(directory+'/runtime',options);
    expect((await get('setup')).connections).toHaveLength(1);
    expect((await request('setup/delete-agent',{id:'../../other'})).status).toBe(400);
    expect((await request('setup/select',{id:other.id})).status).toBe(200);
    expect((await request('setup/delete-agent',{id:other.id})).status).toBe(200);
    expect((await get('setup')).profiles).toHaveLength(0);

  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
},30000);

test('changing an agent connection preserves history, moves references and restores on failure', async()=>{
  const directory=await mkdtemp('/tmp/as-switch-');
  await mkdir(directory+'/assets');await writeFile(directory+'/assets/index.html','Assistant');
  const original={id:'111111111111',name:'Writer',provider:{...provider,baseURL:'https://api.openai.com/v1',apiMode:'responses',webSearch:true}};
  const target={id:'222222222222',name:'Research',provider:{kind:'qwen',service:'qwencloud',model:'qwen-test',apiKey:'qwen-secret'}};
  let stored=JSON.stringify({version:1,active:original.id,profiles:[original,target]});
  let failWrite=false,failStart=false,failProbe=false;
  const probes:Parameters<typeof testProvider>[0][]=[];
  const options={assetsDirectory:directory+'/assets',secrets:{async read(){return stored;},async write(value:string){if(failWrite)throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');stored=value;}},
    validateProvider:async(value:Parameters<typeof testProvider>[0])=>{probes.push(value);if(failProbe)throw new Error('SETUP_PROVIDER_AUTH');},
    startHost:async(input:Parameters<typeof startAssistantHost>[0])=>{
      if(failStart){failStart=false;throw new Error('SETUP_FAILED');}
      return startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:`${input.engine?.provider}:${input.engine?.model}`},{type:'finish',finishReason:'stop'}]]})}});
    }};
  let app=await startManagedAssistant(directory+'/runtime',options);
  const request=async(route:string,body?:unknown)=>fetch(app.origin+'/api/'+route,{headers:{authorization:'Bearer '+new URLSearchParams(new URL(app.url).hash.slice(1)).get('token'),origin:app.origin,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const get=async(route:string)=>await(await request(route)).json() as any;
  try{
    expect(await get('setup')).toMatchObject({ready:true,error:null});
    expect((await request('message',{prompt:'Start',key:randomUUID()})).status).toBe(200);
    const sessionId=(await get('state')).sessions[0].sessionId;
    const connections=(await get('setup')).connections;
    const from=connections.find((c:any)=>c.kind==='openai-compatible').id,to=connections.find((c:any)=>c.kind==='qwen').id;
    const before=stored;
    for(const failure of ['probe','start','storage']){
      failProbe=failure==='probe';failStart=failure==='start';failWrite=failure==='storage';
      expect((await request('setup/agent-connection',{id:original.id,connectionId:to})).status).toBe(400);
      expect(stored).toBe(before);expect((await get('setup')).ready).toBe(true);
      expect((await get('state')).sessions[0].sessionId).toBe(sessionId);
      failProbe=false;failWrite=false;
    }
    expect((await request('setup/agent-connection',{id:original.id,connectionId:'missing'})).status).toBe(400);
    expect((await request('setup/agent-connection',{id:target.id,connectionId:from})).status).toBe(400);
    expect((await request('setup/agent-connection',{id:original.id,connectionId:to,model:'qwen-new'})).status).toBe(200);
    expect(probes.at(-1)).toMatchObject({kind:'qwen',model:'qwen-new',apiKey:'qwen-secret'});
    expect((await get('setup')).profiles[0]).toMatchObject({id:original.id,name:'Writer',connectionId:to,provider:{kind:'qwen',model:'qwen-new'}});
    expect((await get('setup')).connections.find((c:any)=>c.id===from).agents).toHaveLength(0);
    expect((await request('setup/delete-connection',{id:to})).status).toBe(400);
    expect(JSON.stringify(await get('setup'))).not.toContain('qwen-secret');
    await request('message',{sessionId,prompt:'Continue',key:randomUUID()});
    expect((await get('state')).sessions[0].runs.at(-1).output).toBe('qwen:qwen-new');
    await app.close();app=await startManagedAssistant(directory+'/runtime',options);
    expect((await get('setup')).ready).toBe(true);
    expect((await get('state')).sessions[0].sessionId).toBe(sessionId);
    // Switching back also restores the saved provider's capabilities and default model.
    expect((await request('setup/agent-connection',{id:original.id,connectionId:from})).status).toBe(200);
    expect((await get('setup')).provider).toMatchObject({kind:'openai-compatible',webSearch:true,model:'test'});
    expect((await get('state')).sessions[0].runs).toHaveLength(2);
    const unchanged=stored;
    failWrite=true;
    expect((await request('setup/agent-update',{id:original.id,name:'Updated',connectionId:from,model:'next-model',webSearch:false})).status).toBe(400);
    expect(stored).toBe(unchanged);expect((await get('setup')).ready).toBe(true);
    failWrite=false;
    expect((await request('setup/agent-update',{id:original.id,name:'Updated',connectionId:from,model:'next-model',webSearch:false})).status).toBe(200);
    expect((await get('setup')).profiles[0]).toMatchObject({name:'Updated',provider:{model:'next-model',webSearch:false}});
    expect((await get('state')).sessions[0].runs).toHaveLength(2);
    expect((await request('setup/agent-update',{id:original.id,name:'Invalid',connectionId:to,model:'qwen-test',webSearch:true})).status).toBe(400);
    expect((await get('setup')).profiles[0].name).toBe('Updated');

  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
},30000);
