import { test, expect } from 'bun:test';
import { costs, quantiles, evidenceVerdict, negativeEvidence, validateOracle } from '../scripts/task-measurement-core.mjs';
const evidence = {schemaVersion:1,artifactSha256:'a'.repeat(64),structure:'verified',correspondence:'current',checks:[{id:'test',status:'confirmed'}],protectedIntact:true,unknownEffects:0,missingEvidence:false,support:'host_durable_contract_journal_budget_and_fresh_native_snapshot',reportedVisibleOutput:5,observedVisibleOutput:5};
test('nearest-rank keeps outliers and empty remains unknown',()=>{expect(quantiles([]).p95).toBeNull();expect(quantiles([1,2,3,4,100])).toEqual({n:5,min:1,p50:3,p95:100,max:100});expect(()=>quantiles([NaN])).toThrow();});
test('all failed attempts and auxiliary costs count once, accepted tasks deduplicate',()=>{
 const rows=['attempt','retry','compaction','review','routing','child','infrastructure'].map((category,i)=>({id:String(i),taskId:'task',category,status:'known',currency:'USD',amount:i+1}));
 expect(costs(rows,['task','task']).costPerAcceptedTask).toBe(28);
 expect(costs(rows,[])).toMatchObject({knownSpend:28,acceptedTasks:0,costPerAcceptedTask:null,ratioStatus:'undefined_zero_accepted'});
 expect(()=>costs([...rows,rows[0]],['task'])).toThrow();expect(()=>costs(rows,['missing'])).toThrow();
});
test('unknown and mock costs cannot become zero or real savings',()=>{
 const base={id:'a',taskId:'t',category:'attempt',amount:null,reason:'synthetic model'};
 expect(costs([{...base,status:'not_applicable'}],['t']).ratioStatus).toBe('not_applicable');
 expect(costs([{...base,status:'unknown'}],['t']).costPerAcceptedTask).toBeNull();
 expect(()=>costs([{...base,status:'unknown',amount:0}],[])).toThrow();
 expect(()=>costs([{...base,status:'known',currency:'USD',amount:-1}],[])).toThrow();
});
test('oracle fails closed for stale, missing, unsupported and altered evidence',()=>{
 expect(evidenceVerdict(evidence,'a'.repeat(64)).accepted).toBe(true);
 for(const row of negativeEvidence(evidence))expect(evidenceVerdict(row.evidence,'a'.repeat(64)).accepted).toBe(false);
 expect(evidenceVerdict(null,'a'.repeat(64)).accepted).toBe(false);
 for(const key of Object.keys(evidence)){const copy={...evidence};delete copy[key];expect(evidenceVerdict(copy,'a'.repeat(64)).accepted).toBe(false);}
});

test('malformed or misbound oracle output cannot count as a negative rejection',()=>{
 const base={accepted:false,failures:['case'],observed:[4],moduleSha256:'module',casesSha256:'cases'};
 expect(validateOracle(base,'module','cases')).toBe(base);
 for(const patch of [{accepted:undefined},{accepted:'false'},{accepted:true},{failures:[]},{failures:[null]},{observed:null},{moduleSha256:'other'},{casesSha256:'other'}])expect(()=>validateOracle({...base,...patch},'module','cases')).toThrow();
});

test('separate-process oracle grades executed bytes and rejects wrong output or mutation', async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {sha256}=await import('../scripts/task-measurement-core.mjs');
 const dir=await mkdtemp('/tmp/hu74-oracle-test-');
 try{
  const cases=JSON.stringify([{id:'sum',input:[1,2],expected:3}]);await writeFile(dir+'/cases.json',cases);
  for(const [source,accepted] of [['export const f = rows => rows.reduce((a,b)=>a+b,0);',true],['export const f = rows => 99;',false],['export const f = rows => {rows.push(0);return 3;};',false]]){
   await writeFile(dir+'/module.mjs',source);
   const child=Bun.spawnSync([process.execPath,'scripts/task-measurement-oracle.mjs',dir+'/module.mjs',dir+'/cases.json','f']);expect(child.exitCode).toBe(0);
   const result=validateOracle(JSON.parse(child.stdout.toString()),sha256(source),sha256(cases));expect(result.accepted).toBe(accepted);
  }
  await writeFile(dir+'/cases.json','[]');expect(Bun.spawnSync([process.execPath,'scripts/task-measurement-oracle.mjs',dir+'/module.mjs',dir+'/cases.json','f']).exitCode).not.toBe(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
