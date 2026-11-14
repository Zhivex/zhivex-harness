import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
import {gradeHardAnswer} from './hard-preload-fixtures.js';
export function diagnosePlannerAnswer(answer:string){
 let parsed:any;
 try{parsed=JSON.parse(answer);}catch{return {kind:'json_parse',feedback:'JSON.parse rejected the previous response. Return exactly one valid JSON object with replacement, explanation and regressions. Fix delimiters and escaping; no trailing content, markdown, or raw function outside JSON.'};}
 if(typeof parsed.replacement!=='string')return {kind:'schema',feedback:'The JSON object must contain replacement as a JavaScript function string, explanation as text, and exactly three regression objects.'};
 try{
  const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
  const observed=JSON.parse(vm.runInContext(`'use strict'; ${parsed.replacement}; JSON.stringify(planJobs([{id:'probe',deps:[]}]));`,context,{timeout:100}));
  if(!isDeepStrictEqual(observed,{rounds:[['probe']],blocked:[]}))return {kind:'wrong_result',feedback:'On input [{id:"probe",deps:[]}], expected {rounds:[["probe"]],blocked:[]}. The candidate returned a different result. Recheck the complete contract.'};
 }catch(error){
  if((error as {code?:string}).code==='ERR_SCRIPT_EXECUTION_TIMEOUT')return {kind:'nontermination',feedback:'The candidate exceeded the 100 ms execution limit on planJobs([{id:"probe",deps:[]}]). Expected {rounds:[["probe"]],blocked:[]}. Diagnose why the iteration fails to terminate and correct it while preserving the complete repository contract.'};
  return {kind:'execution_error',feedback:'The candidate threw while evaluating planJobs([{id:"probe",deps:[]}]). Expected {rounds:[["probe"]],blocked:[]}. Return valid executable JavaScript and obey every contract rule.'};
 }
 const q=gradeHardAnswer('dependency-planner',answer);
 return {kind:q.pass?'pass':'contract',feedback:q.pass?'All existing acceptance checks passed.':`The candidate passed ${q.passed}/${q.tests} functional cases and ${q.regressions}/3 regression-example checks. Format=${q.format}, explanation length=${q.length}. Correct every failed acceptance dimension using the repository contract.`};
}
/** Additional independent, deterministic planner assertions; never sent in retry feedback. */
export function additionalPlannerChecks(answer:string){
 const cases=[
  {jobs:[{id:'root',deps:[]},{id:'left',deps:['root']},{id:'right',deps:['root']},{id:'join',deps:['left','right']},{id:'tail',deps:['join']}],expected:{rounds:[['root'],['left','right'],['join'],['tail']],blocked:[]}},
  {jobs:[{id:'C',deps:['B']},{id:'B',deps:['A']},{id:'A',deps:['C']},{id:'leaf',deps:['B']},{id:'ready',deps:[]}],expected:{rounds:[['ready']],blocked:['A','B','C','leaf']}},
  {jobs:[{id:'off',deps:[],disabled:true},{id:'mid',deps:['off']},{id:'leaf',deps:['mid']},{id:'missing',deps:['ghost']},{id:'ok',deps:[]}],expected:{rounds:[['ok']],blocked:['leaf','mid','missing','off']}},
  {jobs:[{id:'😀',deps:[]},{id:'z',deps:[]},{id:'Z',deps:[]},{id:'10',deps:[]},{id:'2',deps:[]},{id:'join',deps:['😀','z','Z','10','2','2']}],expected:{rounds:[['10','2','Z','z','😀'],['join']],blocked:[]}},
  {jobs:[{id:'only',deps:['only','only']}],expected:{rounds:[],blocked:['only']}},
  {jobs:[],expected:{rounds:[],blocked:[]}}
 ];
 let passed=0;
 try{const parsed=JSON.parse(answer);if(typeof parsed.replacement!=='string')throw Error();
 for(const t of cases){try{
 const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
 const r=JSON.parse(vm.runInContext(`'use strict'; ${parsed.replacement}; const jobs=${JSON.stringify(t.jobs)}; const before=JSON.stringify(jobs); const value=planJobs(jobs); JSON.stringify({value,unchanged:before===JSON.stringify(jobs)});`,context,{timeout:100}));
 if(r.unchanged&&isDeepStrictEqual(r.value,t.expected))passed++;
 }catch{}}
 }catch{}
 return {tests:cases.length,passed,pass:passed===cases.length};
}
