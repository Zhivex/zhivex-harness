// Offline integration acceptance against the installed provider. No live network calls.
import {createOpenAI} from '@zhivex-ai/openai';
import {createHarness,runHarness} from '../src/harness.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const events=[
 {type:'response.output_item.added',output_index:0,item:{type:'function_call',id:'item',call_id:'call',name:'list_files',arguments:'',status:'in_progress'}},
 {type:'response.function_call_arguments.delta',output_index:0,item_id:'item',delta:'{"path":'},
 {type:'response.output_item.done',output_index:0,item:{type:'function_call',id:'item',call_id:'call',name:'list_files',arguments:'{"path":',status:'incomplete'}},
 {type:'response.incomplete',response:{id:'response',status:'incomplete',usage:{input_tokens:12,output_tokens:8,total_tokens:20},output:[]}}
];
const model=createOpenAI({apiKey:'fixture',fetch:async()=>new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})})('gpt-5.6-luna');
const root=await mkdtemp(path.join(tmpdir(),'ga-installed-accounting-'));
let harness,diagnostics,failed=false,toolExecutions=0;
try{
 harness=await createHarness({workspace:root,modelInstance:model,provider:'openai',agentProfile:'repair',subagentProfiles:[]});
 const original = harness.agent.tools.list_files;
 harness.agent.tools = {...harness.agent.tools, list_files: {...original, execute: async (...args) => { toolExecutions++; return original.execute(...args); }}};
 try{const result=await runHarness(harness,{prompt:'List files.',providerOptions:{apiMode:'responses'}},{onDiagnostics:value=>{diagnostics=value;}});failed=result.status==='failed';}catch{failed=true;}
 const passed=failed && diagnostics?.budget?.inputTokens===12 && diagnostics?.budget?.outputTokens===8 && diagnostics?.budget?.usageComplete===true && toolExecutions===0;
 console.log(JSON.stringify({passed,failed,toolExecutions,inputTokens:diagnostics?.budget?.inputTokens,outputTokens:diagnostics?.budget?.outputTokens,usageComplete:diagnostics?.budget?.usageComplete,network:'mock-only',packages:'workspace Harness with registry-installed providers'}));
 if(!passed)process.exitCode=1;
}finally{await harness?.close();await rm(root,{recursive:true,force:true});}
