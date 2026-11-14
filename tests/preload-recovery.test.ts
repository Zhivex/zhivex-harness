import {test,expect} from 'bun:test';
import {diagnosePlannerAnswer,additionalPlannerChecks} from '../scripts/benchmarks/preload-recovery.js';
import {planJobs} from '../scripts/benchmarks/hard-preload-fixtures.js';
test('recovery diagnostic separates malformed JSON from repeat-ready nontermination',()=>{
 expect(diagnosePlannerAnswer('{"replacement":"x"}]}').kind).toBe('json_parse');
 const broken='function planJobs(jobs){const done=new Set(),rounds=[];while(true){const ready=jobs.filter(j=>j.deps.every(d=>done.has(d))).map(j=>j.id);if(!ready.length)break;rounds.push(ready);ready.forEach(id=>done.add(id));}return {rounds,blocked:[]};}';
 expect(diagnosePlannerAnswer(JSON.stringify({replacement:broken})).kind).toBe('nontermination');
 expect(additionalPlannerChecks(JSON.stringify({replacement:broken})).pass).toBe(false);
});
test('additional planner checks accept reference and reject destructive or constant candidates',()=>{
 expect(additionalPlannerChecks(JSON.stringify({replacement:planJobs.toString()}))).toMatchObject({tests:6,passed:6,pass:true});
 expect(additionalPlannerChecks('{"replacement":"function planJobs(jobs){jobs.length=0;return {rounds:[],blocked:[]};}"}').pass).toBe(false);
});
