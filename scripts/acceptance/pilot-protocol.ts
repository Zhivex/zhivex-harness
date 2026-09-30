import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ACCEPTANCE_FIXTURES,ACCEPTANCE_REVISION} from './fixtures.js';

const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/);
const sha=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count=z.number().int().nonnegative().safe();
const positive=count.min(1);
const amount=z.number().finite().nonnegative();
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value && typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',')+'}':JSON.stringify(value);
export const pilotDigest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
export const pilotFixtureIdentity=()=>({revision:ACCEPTANCE_REVISION,sha256:'sha256:'+createHash('sha256').update(JSON.stringify(ACCEPTANCE_FIXTURES)).digest('hex')});
const budget=z.strictObject({timeoutMs:positive.max(600_000),maxInputTokens:positive.max(1_000_000),maxOutputTokens:positive.max(1_000_000),maxTotalTokens:positive.max(2_000_000),maxSteps:positive.max(1000),maxToolCalls:positive.max(1000)});
const participant=z.strictObject({id:identifier,tool:identifier,version:identifier,artifactDigest:sha,configurationDigest:sha,
 model:z.strictObject({provider:identifier,id:identifier,route:identifier,settingsDigest:sha}),
 budgetSupport:z.literal('enforced')});
export const competitivePilotPlanSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('competitive-pilot-plan'),
 comparison:z.enum(['same-model-harness','product']),
 fixtures:z.strictObject({revision:identifier,sha256:sha,ids:z.array(identifier).min(1).max(32)}),
 participants:z.array(participant).min(2).max(8),budget,approvalPolicyDigest:sha,
 repetitions:positive.max(10),maximumAttempts:positive.max(3),retryPolicy:z.literal('failed-only'),
 order:z.literal('rotating-participants'),certificationEvidenceDigest:sha
}).superRefine((value,context)=>{
 const issue=(message:string)=>context.addIssue({code:'custom',message});
 if(new Set(value.participants.map(item=>item.id)).size!==value.participants.length)issue('Duplicate participant');
 if(new Set(value.participants.map(item=>item.tool)).size!==value.participants.length)issue('Use distinct tools in a competitive pilot');
 if(!value.participants.some(item=>item.tool==='harness'))issue('Harness participant is required');
 if(new Set(value.fixtures.ids).size!==value.fixtures.ids.length)issue('Duplicate fixture');
 if(value.comparison==='same-model-harness' && value.participants.some(item=>canonical(item.model)!==canonical(value.participants[0]!.model)))issue('Harness comparison requires identical provider, model, route and model settings');
 if(value.budget.maxTotalTokens>value.budget.maxInputTokens+value.budget.maxOutputTokens)issue('Total token limit exceeds component limits');
});
export type CompetitivePilotPlan=z.infer<typeof competitivePilotPlanSchema>;

/** Freezes task identity before execution; no default competitors, versions or certification are invented. */
export function compileCompetitivePilotPlan(input:unknown) {
 if(Buffer.byteLength(JSON.stringify(input)??'')>64*1024)throw new Error('PILOT_PLAN_LIMIT');
 const plan=competitivePilotPlanSchema.parse(input),identity=pilotFixtureIdentity();
 if(plan.fixtures.revision!==identity.revision || plan.fixtures.sha256!==identity.sha256 || plan.fixtures.ids.some(id=>!ACCEPTANCE_FIXTURES.some(fixture=>fixture.id===id)))throw new Error('PILOT_FIXTURE_MISMATCH');
 const schedule:Array<{participantId:string;fixtureId:string;repetition:number}>=[];
 for(let repetition=1;repetition<=plan.repetitions;repetition++)for(let fixtureIndex=0;fixtureIndex<plan.fixtures.ids.length;fixtureIndex++) {
  const offset=(repetition-1+fixtureIndex)%plan.participants.length;
  for(let index=0;index<plan.participants.length;index++)schedule.push({participantId:plan.participants[(index+offset)%plan.participants.length]!.id,fixtureId:plan.fixtures.ids[fixtureIndex]!,repetition});
 }
 return {plan,digest:pilotDigest(plan),budgetDigest:pilotDigest(plan.budget),schedule};
}

export const competitivePilotAttemptSchema=z.strictObject({schemaVersion:z.literal(1),planDigest:sha,participantId:identifier,fixtureId:identifier,repetition:positive,attempt:positive.max(3),
 artifactDigest:sha,configurationDigest:sha,modelDigest:sha,budgetDigest:sha,approvalPolicyDigest:sha,
 status:z.enum(['passed','failed','blocked']),independentTestsPassed:z.boolean(),protectedFilesUnchanged:z.boolean(),
 evidenceDigest:sha,diagnostic:z.enum(['none','verification_failed','tool_failed','provider_failed','missing_access','budget_exhausted','interrupted','unsupported']),
 durationMs:amount.nullable(),steps:count.nullable(),toolCalls:count.nullable(),inputTokens:count.nullable(),outputTokens:count.nullable(),usageComplete:z.boolean(),
 costUsd:amount.nullable(),pricingEvidenceDigest:sha.nullable(),costKind:z.literal('estimate-not-invoice'),
 humanInterventions:count.nullable(),automatedApprovals:count.nullable(),scriptedUserCorrections:count.nullable()
}).superRefine((row,context)=>{
 const issue=(message:string)=>context.addIssue({code:'custom',message});
 if(row.status==='passed' && (!row.independentTestsPassed || !row.protectedFilesUnchanged || row.diagnostic!=='none'))issue('Success requires independent verification and unchanged protected files');
 if(row.usageComplete && (row.inputTokens===null || row.outputTokens===null))issue('Complete usage requires both token counts');
 if(row.costUsd!==null && row.pricingEvidenceDigest===null)issue('Cost requires pricing evidence');
 if(row.status!=='passed' && row.diagnostic==='none')issue('Failure or blockage requires a diagnostic');
});
export type CompetitivePilotAttempt=z.infer<typeof competitivePilotAttemptSchema>;

/** Validates the complete attempt journal against the predeclared matrix; retries cannot erase failures. */
export function summarizeCompetitivePilot(planInput:unknown,attemptInputs:readonly unknown[]) {
 const compiled=compileCompetitivePilotPlan(planInput),{plan,digest,schedule}=compiled;
 if(attemptInputs.length>schedule.length*plan.maximumAttempts)throw new Error('PILOT_ATTEMPT_LIMIT');
 const rows=attemptInputs.map(input=>competitivePilotAttemptSchema.parse(input));
 const key=(row:{participantId:string;fixtureId:string;repetition:number})=>JSON.stringify([row.participantId,row.fixtureId,row.repetition]);
 const planned=new Set(schedule.map(key)),groups=new Map<string,CompetitivePilotAttempt[]>();
 for(const row of rows) {
  const participant=plan.participants.find(item=>item.id===row.participantId);
  if(!participant || !planned.has(key(row)) || row.planDigest!==digest || row.artifactDigest!==participant.artifactDigest || row.configurationDigest!==participant.configurationDigest || row.modelDigest!==pilotDigest(participant.model) || row.budgetDigest!==compiled.budgetDigest || row.approvalPolicyDigest!==plan.approvalPolicyDigest)throw new Error('PILOT_BINDING_MISMATCH');
  const overBudget=(row.durationMs!==null && row.durationMs>plan.budget.timeoutMs) || (row.steps!==null && row.steps>plan.budget.maxSteps) || (row.toolCalls!==null && row.toolCalls>plan.budget.maxToolCalls) ||
    (row.inputTokens!==null && row.inputTokens>plan.budget.maxInputTokens) || (row.outputTokens!==null && row.outputTokens>plan.budget.maxOutputTokens) ||
    ((row.inputTokens??0)+(row.outputTokens??0)>plan.budget.maxTotalTokens);
  if(row.status==='passed' && overBudget)throw new Error('PILOT_BUDGET_EXCEEDED');
  const previous=groups.get(key(row))??[];
  if(row.attempt!==previous.length+1 || row.attempt>plan.maximumAttempts || previous.length && previous.at(-1)!.status!=='failed')throw new Error('PILOT_RETRY_POLICY');
  previous.push(row);groups.set(key(row),previous);
 }
 // The declared order is part of the experiment. A missing cell does not authorize later cells.
 let cursor=0;
 for(const cell of schedule) {
  const group=groups.get(key(cell))??[];
  for(const row of group)if(rows[cursor++]!==row)throw new Error('PILOT_ORDER_MISMATCH');
  if(!group.length || group.at(-1)!.status==='failed' && group.length<plan.maximumAttempts)break;
 }
 if(cursor!==rows.length)throw new Error('PILOT_ORDER_MISMATCH');
 const metrics=plan.participants.map(participant=>{
  const cells=schedule.filter(cell=>cell.participantId===participant.id);
  const attempts=rows.filter(row=>row.participantId===participant.id);
  const first=attempts.filter(row=>row.attempt===1);
  const missing=cells.filter(cell=>!groups.has(key(cell))).length;
  const unfinished=cells.filter(cell=>{const group=groups.get(key(cell));return group?.at(-1)?.status==='failed' && group.length<plan.maximumAttempts;}).length;
  const knownSum=(field:'durationMs'|'costUsd'|'inputTokens'|'outputTokens'|'humanInterventions'|'automatedApprovals'|'scriptedUserCorrections')=>({reported:attempts.filter(row=>row[field]!==null).length,total:attempts.some(row=>row[field]!==null)?attempts.reduce((sum,row)=>sum+(row[field]??0),0):null,complete:attempts.length>0 && attempts.every(row=>row[field]!==null)});
  return {participantId:participant.id,plannedCases:cells.length,attemptedCases:first.length,missingCases:missing,unfinishedCases:unfinished,
   firstAttemptPassed:first.filter(row=>row.status==='passed').length,firstAttemptPassRate:first.filter(row=>row.status==='passed').length/cells.length,
   recovered:attempts.filter(row=>row.attempt>1 && row.status==='passed').length,failedAttempts:attempts.filter(row=>row.status==='failed').length,blockedAttempts:attempts.filter(row=>row.status==='blocked').length,
   durationMs:knownSum('durationMs'),costUsd:knownSum('costUsd'),inputTokens:knownSum('inputTokens'),outputTokens:knownSum('outputTokens'),humanInterventions:knownSum('humanInterventions'),
   budgetEvidenceComplete:attempts.length>0 && attempts.every(row=>row.durationMs!==null && row.steps!==null && row.toolCalls!==null && row.usageComplete),
   usageComplete:attempts.length>0 && attempts.every(row=>row.usageComplete),automatedApprovals:knownSum('automatedApprovals'),scriptedUserCorrections:knownSum('scriptedUserCorrections')};
 });
 return {schemaVersion:1,kind:'competitive-pilot-summary',planDigest:digest,comparison:plan.comparison,
  complete:metrics.every(row=>row.missingCases===0 && row.unfinishedCases===0),metrics,rows,
  limitations:['Small fixed task sample; no general superiority claim','Evidence digests bind supplied observations; they do not authenticate an evaluator','Missing and blocked cases remain in the planned denominator','Product comparison does not isolate harness effects','Reported sums include all attempts; partial values are not complete cost or usage totals']};
}
