import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {fixture,tasks} from './fixtures.js';
import {createWorkingReadReplay} from '../../../packages/core/src/context/working-read-replay.js';
import type {AgentRunState,ModelMessage,ToolSet} from '@zhivex-ai/core';
const root=await mkdtemp('/tmp/replay-equivalence-');
try{
 const source=await readFile(process.argv[2]!,'utf8');
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(source);
 await writeFile(root+'/prior.mjs',js);
 const prior=await import(pathToFileURL(root+'/prior.mjs').href);
 let comparisons=0;
 for(const task of tasks){const data=await fixture(task,6);const replay=createWorkingReadReplay();
  for(let count=2;count<=6;count++){
   const reads=data.paths.slice(0,count).map((p,i)=>({toolCallId:'call-'+i,toolName:'read_file',isError:false,output:{path:p,digest:'sha256:'+data.hash,startLine:1,endLine:data.files[p]!.split('\n').length,totalLines:data.files[p]!.split('\n').length,truncated:false,clippedLine:false,content:data.files[p]!.split('\n').map((line,n)=>`${n+1}: ${line}`).join('\n')}}));
   const steps=reads.map((r,i)=>({index:i,response:{messages:[{role:'assistant',parts:[{type:'tool-call',toolCall:{id:r.toolCallId,name:r.toolName,input:{path:r.output.path,startLine:1,endLine:2000}}}]}]},toolResults:[r]}));
   const state={runId:task,revision:count,compactions:[{}],steps,toolResults:reads} as unknown as AgentRunState;
   const messages=[{role:'assistant',parts:[{type:'text',text:'[Compacted prior conversation]\nsummary'}]}] as ModelMessage[];
   const tools={read_file:{}} as unknown as ToolSet;
   assert.deepEqual(replay(messages,state,tools),prior.replayCompactedReads(messages,state,tools));comparisons++;
   assert.deepEqual(replay(messages,state,tools),prior.replayCompactedReads(messages,state,tools));comparisons++;
  }
 }
 console.log(JSON.stringify({comparisons,identicalNonRepetitiveWireMessages:true,coldAndWarmCache:true}));
}finally{await rm(root,{recursive:true,force:true});}
