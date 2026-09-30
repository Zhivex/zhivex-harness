import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {tool,wrapLanguageModel,type LanguageModel,type ModelMessage,type ToolExecutionResult,type ToolSet} from '@zhivex-ai/core';
import type {HarnessDelegationContract} from './delegation-contracts.js';
import {validateDelegationResult} from './delegation-result.js';

export const DELEGATION_FEEDBACK_TOOL='__harness_result_feedback';
const reasons=z.enum(['invalid_json','invalid_schema','task_mismatch','incomplete','duplicate_claim','path_denied','evidence_missing','coverage_missing']);
const receipts=(messages:readonly ModelMessage[]):ToolExecutionResult[]=>messages.flatMap(message=>message.role==='tool'?message.parts.flatMap(part=>part.type==='tool-result'?[part.toolResult]:[]):[]);
export const delegationCorrectionCount=(results:readonly ToolExecutionResult[])=>results.filter(result=>result.toolName===DELEGATION_FEEDBACK_TOOL).length;

/** Internal no-effect continuation lets SDK steps, journals, budgets and cancellation govern every retry. */
export function createDelegationCorrection(model:LanguageModel,contract:HarnessDelegationContract):{model:LanguageModel;tools:ToolSet} {
  const maximum=contract.resultContract?.maxCorrections??0;
  if(!maximum)return {model,tools:{}};
  const feedback=tool({name:DELEGATION_FEEDBACK_TOOL,description:'Host-only result feedback; no filesystem or execution authority.',
    schema:z.strictObject({candidate:z.string().max(64*1024),reason:reasons,attempt:z.number().int().min(1).max(maximum)}),
    execute:async ({reason,attempt})=>({schemaVersion:1,taskId:contract.taskId,attempt,reason,
      instruction:'Return one raw JSON object only: no Markdown fences, backticks, or prose. Correct the final JSON using only the original task and authorized read_file evidence. Read missing permitted slices if needed. Do not change scope or claim semantic verification.'})});
  const prepare=(input:{messages:ModelMessage[];tools?:ToolSet})=>{
    if(input.tools)input.tools=Object.fromEntries(Object.entries(input.tools).filter(([name])=>name!==DELEGATION_FEEDBACK_TOOL));
    return receipts(input.messages);
  };
  const correction=(text:string,results:ToolExecutionResult[])=>{
    const attempt=delegationCorrectionCount(results)+1;
    const assessment=validateDelegationResult(contract,text,results);
    if(Buffer.byteLength(text)>64*1024 || assessment.accepted || attempt>maximum || assessment.reason==='valid')return;
    return {id:'harness_feedback_'+randomUUID(),name:DELEGATION_FEEDBACK_TOOL,input:{candidate:text,reason:assessment.reason,attempt}};
  };
  return {tools:{[DELEGATION_FEEDBACK_TOOL]:feedback},model:wrapLanguageModel(model,[{
    name:'harness-delegation-result-correction-v1',
    async wrapGenerate({input},next){
      const observed=prepare(input);
      const result=await next();
      const messages=result.messages??(result.message?[result.message]:[]);
      if(messages.some(message=>message.parts.some(part=>part.type==='tool-call' && part.toolCall.name===DELEGATION_FEEDBACK_TOOL)))throw new Error('DELEGATION_INTERNAL_TOOL_DENIED');
      if(result.finishReason!=='stop' || messages.some(message=>message.parts.some(part=>part.type==='tool-call')))return result;
      const text=result.text??messages.flatMap(message=>message.parts.flatMap(part=>part.type==='text'?[part.text]:[])).join('');
      const call=correction(text,observed);if(!call)return result;
      const message:ModelMessage={role:'assistant',parts:[{type:'tool-call',toolCall:call}]};
      return {...result,text:'',message,messages:[message],finishReason:'tool-calls',providerFinishReason:'harness-result-correction'};
    },
    async wrapStream({input},next){
      const observed=prepare(input),stream=await next();
      return (async function*(){
        let text='',sawTool=false,tooLarge=false,finish:Extract<import('@zhivex-ai/core').StreamEvent,{type:'finish'}>|undefined;
        for await(const event of stream) {
          if(event.type==='tool-call'){
            if(event.toolCall.name===DELEGATION_FEEDBACK_TOOL)throw new Error('DELEGATION_INTERNAL_TOOL_DENIED');
            sawTool=true;
          }
          if(event.type==='text-delta') {
            if(tooLarge)yield event;
            else {text+=event.textDelta;if(Buffer.byteLength(text)>64*1024){tooLarge=true;yield {type:'text-delta' as const,textDelta:text};text='';}}
            continue;
          }
          if(event.type==='finish'){if(finish)throw new Error('DELEGATION_AMBIGUOUS_STREAM');finish=event;}else yield event;
        }
        if(!finish)return;
        const call=!tooLarge && !sawTool && finish.finishReason==='stop'?correction(text,observed):undefined;
        if(!call && text)yield {type:'text-delta' as const,textDelta:text};
        if(call)yield {type:'tool-call' as const,toolCall:call};
        yield call?{...finish,finishReason:'tool-calls' as const,providerFinishReason:'harness-result-correction'}:finish;
      })();
    }
  }])};
}
