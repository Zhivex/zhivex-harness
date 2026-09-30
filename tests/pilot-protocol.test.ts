import {expect,test} from 'bun:test';
import {compileCompetitivePilotPlan,pilotDigest,pilotFixtureIdentity,summarizeCompetitivePilot,type CompetitivePilotAttempt} from '../scripts/acceptance/pilot-protocol.js';
const sha='sha256:'+'a'.repeat(64);
const participant=(id:string,tool:string)=>({id,tool,version:'fixture-1',artifactDigest:sha,configurationDigest:sha,model:{provider:'fixture-provider',id:'fixture-model',route:'direct-api',settingsDigest:sha},budgetSupport:'enforced'});
const plan=()=>({schemaVersion:1,kind:'competitive-pilot-plan',comparison:'same-model-harness',fixtures:{...pilotFixtureIdentity(),ids:['bug','approval']},participants:[participant('h','harness'),participant('c','fixture-competitor')],budget:{timeoutMs:1000,maxSteps:4,maxToolCalls:4,maxInputTokens:100,maxOutputTokens:100,maxTotalTokens:200},approvalPolicyDigest:sha,repetitions:1,maximumAttempts:1,retryPolicy:'failed-only',order:'rotating-participants',certificationEvidenceDigest:sha});
function rows(input=plan()):CompetitivePilotAttempt[] {
 const compiled=compileCompetitivePilotPlan(input);
 return compiled.schedule.map(cell=>{
  const tool=compiled.plan.participants.find(item=>item.id===cell.participantId)!;
  return {schemaVersion:1,planDigest:compiled.digest,...cell,attempt:1,artifactDigest:tool.artifactDigest,configurationDigest:tool.configurationDigest,modelDigest:pilotDigest(tool.model),budgetDigest:compiled.budgetDigest,approvalPolicyDigest:sha,
   status:'passed',independentTestsPassed:true,protectedFilesUnchanged:true,evidenceDigest:sha,diagnostic:'none',durationMs:50,steps:1,toolCalls:1,inputTokens:10,outputTokens:5,usageComplete:true,costUsd:null,pricingEvidenceDigest:null,costKind:'estimate-not-invoice',humanInterventions:0,automatedApprovals:1,scriptedUserCorrections:0};
 });
}
test('fixes fixture identity, detaches input and rotates participant order',()=>{
 const input=plan(),compiled=compileCompetitivePilotPlan(input);
 expect(compiled.schedule.map(row=>row.participantId)).toEqual(['h','c','c','h']);
 input.participants[0]!.version='changed';expect(compiled.plan.participants[0]!.version).toBe('fixture-1');
 expect(compileCompetitivePilotPlan(input).digest).not.toBe(compiled.digest);
 const altered=plan();altered.fixtures.sha256='sha256:'+'b'.repeat(64);expect(()=>compileCompetitivePilotPlan(altered)).toThrow('FIXTURE_MISMATCH');
});
test('same-model comparison refuses provider/model/route/settings changes; product comparison labels them',()=>{
 for(const field of ['provider','id','route','settingsDigest'] as const){const input=plan();input.participants[1]!.model[field]=field==='settingsDigest'?'sha256:'+'b'.repeat(64):'other';expect(()=>compileCompetitivePilotPlan(input)).toThrow('identical');input.comparison='product';expect(compileCompetitivePilotPlan(input).plan.comparison).toBe('product');}
});
test('a complete verified matrix has explicit planned denominators and unknown cost',()=>{
 const result=summarizeCompetitivePilot(plan(),rows());expect(result.complete).toBe(true);
 expect(result.metrics[0]).toMatchObject({plannedCases:2,firstAttemptPassed:2,firstAttemptPassRate:1,costUsd:{total:null,reported:0,complete:false},humanInterventions:{total:0,complete:true},budgetEvidenceComplete:true});
});
test('missing and blocked cells remain visible and cannot become a perfect campaign',()=>{
 const attempts=rows().slice(0,1);attempts[0]!.status='blocked';attempts[0]!.diagnostic='missing_access';attempts[0]!.independentTestsPassed=false;
 const result=summarizeCompetitivePilot(plan(),attempts);expect(result.complete).toBe(false);
 expect(result.metrics[0]).toMatchObject({plannedCases:2,firstAttemptPassRate:0,blockedAttempts:1,missingCases:1});
 expect(result.metrics[1]!.missingCases).toBe(2);
});
test('recovery retains first failure and counts all attempts without rewriting first-pass success',()=>{
 const input=plan();input.maximumAttempts=2;const attempts=rows(input),failed={...attempts[0]!,status:'failed' as const,diagnostic:'verification_failed' as const,independentTestsPassed:false};
 const result=summarizeCompetitivePilot(input,[failed,{...attempts[0]!,attempt:2},...attempts.slice(1)]);
 expect(result.complete).toBe(true);expect(result.metrics[0]).toMatchObject({firstAttemptPassed:1,firstAttemptPassRate:0.5,recovered:1,failedAttempts:1,durationMs:{total:150}});
});
test('rejects retries after success/blockage, gaps, duplicates and changing protocol identities',()=>{
 const input=plan();input.maximumAttempts=2;const attempts=rows(input);
 expect(()=>summarizeCompetitivePilot(input,[attempts[0],{...attempts[0]!,attempt:2}])).toThrow('RETRY_POLICY');
 expect(()=>summarizeCompetitivePilot(input,[{...attempts[0]!,attempt:2}])).toThrow('RETRY_POLICY');
 expect(()=>summarizeCompetitivePilot(input,[attempts[0],attempts[0]])).toThrow('RETRY_POLICY');
 for(const field of ['artifactDigest','configurationDigest','modelDigest','budgetDigest','planDigest','approvalPolicyDigest'] as const)expect(()=>summarizeCompetitivePilot(input,[{...attempts[0]!,[field]:'sha256:'+'b'.repeat(64)}])).toThrow('BINDING_MISMATCH');
});
test('stopping after a failed attempt remains incomplete until declared retries are resolved',()=>{
 const input=plan();input.maximumAttempts=2;const attempts=rows(input);const failed={...attempts[0]!,status:'failed' as const,diagnostic:'tool_failed' as const};
 expect(summarizeCompetitivePilot(input,[failed]).metrics[0]!.unfinishedCases).toBe(1);
 expect(()=>summarizeCompetitivePilot(input,[failed,attempts[1]])).toThrow('ORDER_MISMATCH');
 expect(()=>summarizeCompetitivePilot(input,[attempts[1],attempts[0]])).toThrow('ORDER_MISMATCH');
});
test('cannot claim verified success over budget, fabricated free cost, or complete missing usage',()=>{
 const attempts=rows();
 expect(()=>summarizeCompetitivePilot(plan(),[{...attempts[0]!,independentTestsPassed:false}])).toThrow('independent verification');
 expect(()=>summarizeCompetitivePilot(plan(),[{...attempts[0]!,inputTokens:101}])).toThrow('BUDGET_EXCEEDED');
 expect(()=>summarizeCompetitivePilot(plan(),[{...attempts[0]!,costUsd:0}])).toThrow('pricing evidence');
 expect(()=>summarizeCompetitivePilot(plan(),[{...attempts[0]!,inputTokens:null}])).toThrow('Complete usage');
 const partial=summarizeCompetitivePilot(plan(),[{...attempts[0]!,inputTokens:null,usageComplete:false,humanInterventions:null}]);
 expect(partial.metrics[0]).toMatchObject({budgetEvidenceComplete:false,usageComplete:false,inputTokens:{total:null,complete:false},humanInterventions:{total:null,complete:false}});
});

test('offline CLI freezes a plan and refuses to overwrite prior evidence',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const path=await import('node:path');
 const root=await mkdtemp('/tmp/har-pilot-cli-');
 const run=async(args:string[])=>{const child=Bun.spawn([process.execPath,'--no-env-file',path.resolve(import.meta.dir,'../scripts/competitive-pilot.ts'),...args],{cwd:root,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH}});return Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);};
 try {
  await writeFile(root+'/plan.json',JSON.stringify(plan()));
  expect((await run(['lock','plan.json','locked.json']))[0]).toBe(0);
  const locked=await readFile(root+'/locked.json','utf8');expect(JSON.parse(locked).digest).toBe(compileCompetitivePilotPlan(plan()).digest);
  expect((await run(['lock','plan.json','locked.json']))[0]).toBe(1);expect(await readFile(root+'/locked.json','utf8')).toBe(locked);
  await writeFile(root+'/attempts.jsonl',rows().map(row=>JSON.stringify(row)).join('\n')+'\n');
  expect((await run(['summarize','plan.json','attempts.jsonl','summary.json']))[0]).toBe(0);
  expect(JSON.parse(await readFile(root+'/summary.json','utf8')).complete).toBe(true);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('an interrupted worker with missing operator observations cannot claim zero interventions',()=>{
 const attempts=rows();const result=summarizeCompetitivePilot(plan(),[{...attempts[0]!,status:'failed',diagnostic:'interrupted',automatedApprovals:null,scriptedUserCorrections:null,humanInterventions:null}]);
 expect(result.metrics[0]!.automatedApprovals).toEqual({reported:0,total:null,complete:false});
 expect(result.metrics[0]!.scriptedUserCorrections.complete).toBe(false);
});
