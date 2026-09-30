import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createHarness,runHarness} from '@zhivex-ai/harness/engine';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
const [phase,scenario]=process.argv.slice(2);
assert(['execute','inspect'].includes(phase));
const text='one\ntwo',digest='sha256:'+createHash('sha256').update(text).digest('hex');
const maximum=['corrected','exhausted','correction-cancel'].includes(scenario)?1:0;
const contract={taskId:'review',profile:'reviewer',prompt:'Review both lines',allowedReadPaths:['target.txt'],requiredOutput:'LEGACY',
  resultContract:{schemaVersion:1,requiredReadPaths:['target.txt'],humanReviewRequired:true,maxCorrections:maximum}};
const reference={toolCallId:'read',startLine:1,endLine:2};
const result={schemaVersion:1,taskId:'review',status:'completed',inspectedFiles:[{path:'target.txt',digest,evidence:[reference]}],
  findings:[{id:'finding',message:'Requires semantic review',evidence:[{path:'target.txt',...reference}]}]};
if(scenario==='invented')result.findings[0].evidence[0].toolCallId='invented';
if(scenario==='partial'){result.inspectedFiles[0].evidence=[{...reference,endLine:1}];result.findings=[];}
const usage={inputTokens:3,outputTokens:2,totalTokens:5};
const answer=text=>({message:{role:'assistant',parts:[{type:'text',text}]},text,finishReason:'stop',usage});
const childMock=createMockLanguageModel({responses:[
  {message:{role:'assistant',parts:[{type:'tool-call',toolCall:{id:'read',name:'read_file',input:{path:'target.txt',...(scenario==='partial'?{endLine:1}:{})}}}]},finishReason:'tool-calls',usage},
  answer(['invalid','corrected','exhausted','correction-cancel'].includes(scenario)?'invalid':JSON.stringify(result)),
  answer(scenario==='exhausted'?'still invalid':JSON.stringify(result))]});
let calls=0;const controller=new AbortController();
const child={...childMock,generate:async input=>{
  assert.equal(phase,'execute','Inspect must not invoke a model');calls++;
  assert.deepEqual(Object.keys(input.tools??{}),['read_file']);
  if((scenario==='cancellation' && calls===2) || (scenario==='correction-cancel' && calls===3)){controller.abort();input.abortSignal.throwIfAborted();}
  return childMock.generate(input);
}};
const parent=createMockLanguageModel({streamEvents:[[{type:'tool-call',toolCall:{id:'delegate',name:'delegate_reviewer',input:{taskId:'review'}}},{type:'finish',finishReason:'tool-calls',usage}],
  [{type:'text-delta',textDelta:'Parent summary'},{type:'finish',finishReason:'stop',usage}]]});
if(phase==='execute' && scenario!=='tool-error')await writeFile('target.txt',text);
const harness=await createHarness({workspace:process.cwd(),subagentProfiles:['reviewer'],modelInstance:parent,subagentModels:{reviewer:child},delegationContracts:[contract]});
const identity='../identity-'+scenario+'.json';
try {
  if(phase==='execute') {
    await runHarness(harness,{runId:'parent-'+scenario,prompt:'Review the contracted file',abortSignal:controller.signal}).catch(error=>{
      if(!['cancellation','correction-cancel'].includes(scenario))throw error;
      assert(controller.signal.aborted);
    });
    const state=await harness.store.load('parent-'+scenario,harness.config.scope);assert(state);
    assert.equal(state.childRuns.length,1);
    const childState=await harness.store.load(state.childRuns[0].runId,harness.config.scope);assert.equal(childState.parentRunId,state.runId);
    const evidence=state.metadata.zhivexDelegationAcceptanceV1;assert(evidence);
    assert.equal(evidence.evaluations.length,1);const evaluation=evidence.evaluations[0];
    const accepted=['valid','corrected'].includes(scenario);assert.equal(evaluation.accepted,accepted);assert.equal(evaluation.semanticReview,'pending');
    if(accepted)assert.equal(state.status,'completed');
    if(['cancellation','correction-cancel'].includes(scenario)){assert.equal(state.status,'cancelled');assert.notEqual(childState.status,'completed');}
    assert.equal(childState.toolResults.filter(row=>row.toolName==='read_file').length,1);
    if(scenario==='tool-error')assert(childState.toolResults[0].isError);
    if(maximum){assert.equal(calls,3);assert.equal(evaluation.correctionsUsed,1);assert.equal(childState.usage.totalTokens,scenario==='correction-cancel'?10:15);}
    assert.deepEqual(state.childRuns[0].usage,childState.usage);
    const journal=await harness.store.listToolCalls(childState.runId,harness.config.scope);
    await writeFile(identity,JSON.stringify({runId:state.runId,childRunId:childState.runId,evidence,parentStatus:state.status,childStatus:childState.status,usage:childState.usage,journal}));
    console.log(JSON.stringify({phase,scenario,accepted,parentStatus:state.status,childStatus:childState.status,childCalls:calls,corrections:evaluation.correctionsUsed??0,usage:childState.usage}));
  }else {
    const saved=JSON.parse(await readFile(identity,'utf8'));
    const state=await harness.store.load(saved.runId,harness.config.scope),childState=await harness.store.load(saved.childRunId,harness.config.scope);
    assert.deepEqual(state.metadata.zhivexDelegationAcceptanceV1,saved.evidence);
    assert.equal(state.status,saved.parentStatus);assert.equal(childState.status,saved.childStatus);
    assert.deepEqual(childState.usage,saved.usage);assert.equal(childState.parentRunId,saved.runId);
    assert.deepEqual(await harness.store.listToolCalls(saved.childRunId,harness.config.scope),saved.journal);
    assert.equal(calls,0);
    console.log(JSON.stringify({phase,scenario,accepted:saved.evidence.evaluations[0].accepted,reopened:true,evidencePreserved:true,modelCalls:0}));
  }
}finally{await harness.close();}
