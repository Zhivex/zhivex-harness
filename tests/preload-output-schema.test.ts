import {test,expect} from 'bun:test';
import {createOpenAI} from '@zhivex-ai/openai';
import {outputSchema,validateOutputSchema} from '../scripts/benchmarks/preload-output-schema.js';
import {createOpenAICallMeter} from '../scripts/benchmarks/openai-call-meter.js';
test('strict local schemas reject extra keys and malformed JSON without judging code correctness',()=>{
 const valid={replacement:'function planJobs(jobs){return null;}',explanation:'text',regressions:[{name:'test',args:[[{id:'a',deps:[],disabled:false}]],expected:{rounds:[['a']],blocked:[]}}]};
 expect(validateOutputSchema('dependency-planner',JSON.stringify(valid))).toEqual({parseable:true,schemaValid:true});
 expect(validateOutputSchema('dependency-planner',JSON.stringify({...valid,extra:true})).schemaValid).toBe(false);
 expect(validateOutputSchema('dependency-planner',JSON.stringify(valid)+']}').parseable).toBe(false);
 const schema=outputSchema('transfer-ledger').jsonSchema;expect(schema.additionalProperties).toBe(false);
});
test('installed SDK sends native strict JSON Schema unchanged and meter rejects arm mismatch before network',async()=>{
 for(const id of ['dependency-planner','transfer-ledger']){
  const assigned=outputSchema(id);let body:any;let requests=0;
  const fake=(async (_url:any,init:any)=>{requests++;body=JSON.parse(init.body);return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_test',status:'completed',model:'gpt-6-luna',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0}}}})+'\n\n');}) as unknown as typeof fetch;
  const meter=createOpenAICallMeter(fake,'default',()=>1,4096,true,1,{mode:'json_schema',schemaHash:assigned.hash});
  const model=createOpenAI({apiKey:'fixture',fetch:meter.fetch})('gpt-6-luna');
  for await(const _ of await model.stream!({messages:[{role:'user',parts:[{type:'text',text:'fixture'}]}],maxTokens:4096,providerOptions:{apiMode:'responses',text:{format:{type:'json_schema',name:'repository_repair',strict:true,schema:assigned.jsonSchema}}}})){}
  expect(requests).toBe(1);expect(body.text.format.strict).toBe(true);expect(body.text.format.schema).toEqual(assigned.jsonSchema);
  expect(meter.snapshot()[0]).toMatchObject({wireFormat:'json_schema',schemaHash:assigned.hash});
  const mismatch=createOpenAICallMeter(fake,'default',()=>1,4096,true,1,{mode:'text'});
  await expect(mismatch.fetch('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)})).rejects.toThrow('Unexpected constrained');
  expect(requests).toBe(1);
 }
});
