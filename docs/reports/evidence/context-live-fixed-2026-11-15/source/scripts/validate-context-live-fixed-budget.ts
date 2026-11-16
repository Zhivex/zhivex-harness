import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
assert(process.argv.includes('--live') && process.env.OPENAI_API_KEY);
const directory=path.resolve(process.argv[process.argv.indexOf('--directory')+1]!);
const runtime=path.resolve(process.argv[process.argv.indexOf('--runtime')+1]!);
await mkdir(directory);
const report:any={tokenBudget:240000, maxTaskTokens:60000, inputBudget:52000, outputBudget:8000, compactionThreshold:14000, records:[], reportedTokens:0,
  purpose:'Held-out repetition 2 under original constrained budgets; production defaults unchanged. Four prespecified after-only tasks, no retries. Not used as the A/B denominator.'};
for(const model of ['gpt-6-luna','gpt-6.1-sol']) for(const fixture of ['correction','boundary']) {
  assert(report.reportedTokens+60000<=report.tokenBudget);
  const output=path.join(directory,`${model}-${fixture}.json`);
  const child=Bun.spawn([process.execPath,'scripts/benchmark-context-live.ts','--worker','--stateless','--runtime',runtime,'--model',model,'--fixture',fixture,'--repetition','2','--variant','after','--output',output],{env:process.env,stdout:'ignore',stderr:'ignore'});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),195000);
  const exit=await child.exited;clearTimeout(timeout);
  let sample:any;
  try {sample=JSON.parse(await readFile(output,'utf8'));}catch{sample={model,fixture,failure:'WORKER_NO_REPORT',calls:[]};}
  report.records.push(sample);report.reportedTokens+=sample.calls.reduce((n:number,c:any)=>n+(c.usage?.totalTokens??0),0);
  await writeFile(path.join(directory,'validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({model,fixture,status:sample.status,quality:sample.quality?.passed,tokens:sample.usage?.totalTokens,compactions:sample.compactions}));
  assert(exit===0 && sample.calls.length && sample.calls.every((c:any)=>c.usage),'Stop on unknown usage');
}
