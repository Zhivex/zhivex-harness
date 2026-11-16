import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fixture} from './benchmarks/code-context/fixtures.js';
import {grade} from './benchmarks/code-context/grade.js';
const campaign=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const records=[];
for(const row of campaign.records){
 const s=row.sample;let terminal:string|undefined;
 // Sensitivity audit only: accept a complete terminal JSON proposal, while
 // retaining prefix prose as a strict output-contract failure in primary data.
 for(let at=s.answer?.indexOf('{')??-1;at>=0;at=s.answer.indexOf('{',at+1)){
  try{const p=JSON.parse(s.answer.slice(at));if(Array.isArray(p.edits)&&p.evidence){terminal=s.answer.slice(at);break;}}catch{}
 }
 let audited:any={passed:false,error:'No complete terminal JSON proposal'};
 if(terminal){const data=await fixture(s.fixture,s.repetition);assert.equal(data.hash,s.fixtureHash);audited=await grade(data,terminal);}
 records.push({pair:row.pair,model:s.model,variant:s.variant,fixture:s.fixture,files:s.repetition,strictPassed:s.quality?.passed,removedPrefix:terminal!==s.answer,audited});
}
const report={method:'Secondary terminal-JSON extraction audit. Primary strict grades and all paid attempts remain unchanged. This is not a retry or a changed model answer.',records};
await writeFile(process.argv[3]!,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({tasks:records.length,strict:records.filter(r=>r.strictPassed).length,terminalProposalPassed:records.filter(r=>r.audited.passed).length,changed:records.filter(r=>r.strictPassed!==r.audited.passed).map(r=>({pair:r.pair,variant:r.variant}))}));
