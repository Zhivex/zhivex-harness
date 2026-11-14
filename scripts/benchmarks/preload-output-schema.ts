import {z} from 'zod';
import {createHash} from 'node:crypto';
const job=z.strictObject({id:z.string(),deps:z.array(z.string()),disabled:z.boolean()});
const event=z.strictObject({id:z.string(),seq:z.number().int(),from:z.string(),to:z.string(),amount:z.number()});
const balances=z.strictObject({a:z.number(),b:z.number(),c:z.number()});
const planner=z.strictObject({replacement:z.string(),explanation:z.string(),regressions:z.array(z.strictObject({name:z.string(),args:z.array(z.array(job)),expected:z.strictObject({rounds:z.array(z.array(z.string())),blocked:z.array(z.string())})}))});
const ledger=z.strictObject({replacement:z.string(),explanation:z.string(),regressions:z.array(z.strictObject({name:z.string(),args:z.array(z.union([balances,z.array(event),z.number().int()])),expected:z.strictObject({balances,applied:z.array(z.string()),rejected:z.array(z.string()),fees:z.number()})}))});
export function outputSchema(fixture:string){
 const validator=fixture==='dependency-planner'?planner:ledger;
 const jsonSchema=z.toJSONSchema(validator);delete jsonSchema.$schema;
 return {validator,jsonSchema,hash:createHash('sha256').update(JSON.stringify(jsonSchema)).digest('hex'),
 instructions:fixture==='dependency-planner'
 ? 'Each regression args is [jobs]. Every job in regression args must explicitly include exactly id (string), deps (array of strings), and disabled (boolean; use false when enabled). Expected has exactly rounds and blocked.'
 : 'Each regression args is [initial,events,fee]. Use only accounts a,b,c in regression examples: initial and expected.balances must explicitly include exactly a,b,c as numbers, including zero balances. Events have exactly id,seq,from,to,amount; seq and fee are integers. Expected has exactly balances,applied,rejected,fees. The replacement must still support arbitrary account names as stated in the repository contract.'};
}
export function validateOutputSchema(fixture:string,answer:string){try{const p=JSON.parse(answer);return {parseable:true,schemaValid:outputSchema(fixture).validator.safeParse(p).success};}catch{return {parseable:false,schemaValid:false};}}
