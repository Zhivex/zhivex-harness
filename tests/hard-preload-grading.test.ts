import {test,expect} from 'bun:test';
import {hardFixtures,hardCases,planJobs,settle,gradeHardAnswer} from '../scripts/benchmarks/hard-preload-fixtures.js';
const explanation=Array(130).fill('word').join(' ');
test('hard fixture oracles implement contract examples, propagate failures and conserve ledger balances',()=>{
 expect(planJobs([{id:'a',deps:['b']},{id:'b',deps:['a']},{id:'x',deps:[]}])).toEqual({rounds:[['x']],blocked:['a','b']});
 expect(settle({a:10,b:0},[{id:'x',seq:1,from:'a',to:'b',amount:8}],2)).toEqual({balances:{a:0,b:8},applied:['x'],rejected:[],fees:2});
 expect(settle({a:10,b:0},[{id:'x',seq:2,from:'a',to:'b',amount:9},{id:'x',seq:1,from:'a',to:'b',amount:1}],2).rejected).toEqual(['x']);
});
test('hard grader accepts reference code and meaningful regressions, rejects original and truncated candidates',()=>{
 for(const f of hardFixtures){
  const fn=f.id==='dependency-planner'?planJobs:settle;
  const indices=f.id==='dependency-planner'?[2,3,4]:[1,2,3];
  const regressions=indices.map(i=>{const args=hardCases[f.id]![i]!;return{name:'regression '+i,args,expected:(fn as any)(...args)};});
  const answer={replacement:fn.toString(),explanation,regressions};
  expect(gradeHardAnswer(f.id,JSON.stringify(answer))).toMatchObject({pass:true,passed:11,regressions:3});
  expect(gradeHardAnswer(f.id,JSON.stringify({...answer,replacement:Object.values(f.files)[0]!.replace('export ','')})).pass).toBe(false);
  expect(gradeHardAnswer(f.id,JSON.stringify(answer).slice(0,100)).pass).toBe(false);
  expect(gradeHardAnswer(f.id,JSON.stringify({...answer,regressions:[regressions[0],regressions[0],regressions[0]]})).pass).toBe(false);
 }
});
