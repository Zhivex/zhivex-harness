import { mkdtemp, rm } from 'node:fs/promises';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
const directory=await mkdtemp('/tmp/assistant-preview-');
let stored:string|null=null;
const app=await startManagedAssistant(directory,{secrets:{async read(){return stored;},async write(value){stored=value;}},validateProvider:async()=>{},startHost:input=>startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'Listo, tu asistente está conectado.'},{type:'finish',finishReason:'stop'}]]})}})});
console.log(JSON.stringify({url:app.url}));
process.once('SIGTERM',()=>void app.close().then(()=>rm(directory,{recursive:true,force:true})));
