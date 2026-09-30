import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHarness,runHarness,createProviderModel} from '@zhivex-ai/harness';
import {createVertex} from '@zhivex-ai/vertex';
const [phase,provider]=process.argv.slice(2);
assert(['request','resume'].includes(phase));assert(['vertex','gemini','anthropic'].includes(provider));
const model=provider==='anthropic'?'claude-sonnet-5':'gemini-3.7-flash';
const env=provider==='vertex'?{GOOGLE_CLOUD_PROJECT:'fixture-project',VERTEX_LOCATION:'global'}:provider==='gemini'?{GEMINI_API_KEY:'fixture-token'}:{ANTHROPIC_API_KEY:'fixture-token'};
const changes=[{path:'target.txt',content:'signed fixture\n',expectedDigest:null}];
const signature='fixture-signed-continuation';
let requests=0,retained=false,compactionsBefore=0,compactionsAfter=0;
globalThis.fetch=async(_url,init)=>{
 requests++;
 const url=new URL(typeof _url==='string'?_url:_url.url??String(_url));
 assert.equal(url.hostname,provider==='anthropic'?'api.anthropic.com':provider==='gemini'?'generativelanguage.googleapis.com':'aiplatform.googleapis.com');
 const body=JSON.parse(init.body);
 if(phase==='resume'){
  if(provider==='anthropic'){
   const parts=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
   assert(parts.some(p=>p.type==='thinking' && p.signature===signature && p.thinking==='fixture reasoning'));
   assert(parts.some(p=>p.type==='tool_use' && p.id==='signed-edit'));
   assert(parts.some(p=>p.type==='tool_result' && p.tool_use_id==='signed-edit'));
  }else{
   const parts=body.contents.flatMap(m=>m.parts);
   assert(parts.some(p=>p.thoughtSignature===signature && p.functionCall?.id==='signed-edit'));
   assert(parts.some(p=>p.functionResponse?.id==='signed-edit'));
  }retained=true;
 }
 if(provider==='anthropic'){
  const blocks=phase==='request'?[{type:'thinking',thinking:'fixture reasoning',signature},{type:'tool_use',id:'signed-edit',name:'apply_reviewed_edits',input:{changes}}]:[{type:'text',text:'done'}];
  const events=[['message_start',{message:{id:'fixture',usage:{input_tokens:10,output_tokens:3}}}],...blocks.flatMap((block,index)=>[['content_block_start',{index,content_block:block.type==='tool_use'?{...block,input:{}}:block}],...(block.type==='tool_use'?[['content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}]]:[]),['content_block_stop',{index}]]),['message_delta',{delta:{stop_reason:phase==='request'?'tool_use':'end_turn'},usage:{output_tokens:3}}],['message_stop',{}]];
  return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
 }
 const parts=phase==='request'?[{thoughtSignature:signature,functionCall:{id:'signed-edit',name:'apply_reviewed_edits',args:{changes}}}]:[{text:'done'}];
 return new Response(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:3,totalTokenCount:13}})}\n\n`);
};
const modelInstance=provider==='vertex'?createVertex({projectId:'fixture-project',location:'global',getAccessToken:async()=> 'fixture-token'})(model):createProviderModel({provider,model},env);
const harness=await createHarness({provider,model,env,modelInstance,workspace:process.cwd(),maxSteps:3,projectContext:false,subagentProfiles:[],compactionMaxMessages:4,compactionKeepRecentMessages:2});
try{
 if(phase==='request'){
  const messages=Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',parts:[{type:'text',text:'Synthetic earlier context '+i}]}));
  messages.push({role:'user',parts:[{type:'text',text:'Create target.txt'}]});
  const result=await runHarness(harness,{messages,runId:'signed-compaction'});
  assert.equal(result.status,'waiting_approval');assert(result.state.compactions.length>0);
  await assert.rejects(readFile('target.txt'));
  compactionsAfter=result.state.compactions.length;
  await writeFile('evidence.json',JSON.stringify({compactions:result.state.compactions.length}));
 }else{
  const previous=JSON.parse(await readFile('evidence.json','utf8'));
  compactionsBefore=previous.compactions;
  const state=await harness.store.load('signed-compaction',harness.config.scope);assert(state);
  const result=await runHarness(harness,{state,approvals:state.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}))});
  assert.equal(result.status,'completed');assert(retained);compactionsAfter=result.state.compactions.length;
  assert(result.state.compactions.length>previous.compactions,'Resume must compact after the signed call was persisted');
  assert.equal(await readFile('target.txt','utf8'),'signed fixture\n');
  const journal=await harness.store.listToolCalls(result.state.runId,harness.config.scope);
  assert.equal(journal.filter(row=>row.toolName==='apply_reviewed_edits').length,1);
 }
 assert.equal(requests,1);
 console.log(JSON.stringify({provider,phase,passed:true,signedContinuationRetained:phase==='resume',network:false,requests,compactionsBefore,compactionsAfter}));
}finally{await harness.close();}
