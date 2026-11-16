import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {pairedSummary} from './benchmarks/paired-statistics.js';
const report=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const rates:Record<string,{input:number;output:number;cached:number}>={'gpt-6-luna':{input:.1,output:.5,cached:.01},'gpt-6.1-sol':{input:2,output:10,cached:.1}};
const accepted=(s:any)=>s.completed&&s.quality?.passed&&s.security?.passed&&s.contextComplete&&s.initialReadOrder&&JSON.stringify(s.initialReadTurns)===JSON.stringify(Array(s.repetition).fill(1))&&s.usageMatches&&s.calls.length&&s.calls.every((c:any)=>c.usage&&c.terminalType==='response.completed');
const groups=[...new Set<string>(report.plan.map((p:any)=>p.model+'|'+p.threshold))].map(key=>{
 const model=key.split('|')[0]!, threshold=Number(key.split('|')[1]);
 const rate=rates[model]!;
 const variants=['before','after'].map(variant=>{
  const samples=report.records.filter((r:any)=>r.sample.model===model&&r.sample.threshold===threshold&&r.sample.variant===variant).map((r:any)=>r.sample);
  const calls=samples.flatMap((s:any)=>s.calls);const sum=(key:string)=>calls.reduce((n:number,c:any)=>n+(c.usage?.[key]??0),0);
  const correct=samples.filter(accepted).length,unknown=calls.filter((c:any)=>!c.usage).length;
  const input=sum('inputTokens'),output=sum('outputTokens'),cached=sum('cachedInputTokens'),tokens=sum('totalTokens');
  const usd=((input-cached)*rate.input+cached*rate.cached+output*rate.output)/1e6;
  return {variant,attempts:samples.length,correct,unknownReceipts:unknown,inputTokens:input,outputTokens:output,cachedInputTokens:cached,totalTokens:tokens,estimatedKnownUSD:usd,
   usdPerCorrectTask:correct&&!unknown?usd/correct:null,tokensPerCorrectTask:correct&&!unknown?tokens/correct:null,
   meanTaskMs:samples.reduce((n:number,s:any)=>n+s.taskMs,0)/samples.length,meanVerifiedTaskMs:samples.reduce((n:number,s:any)=>n+(s.verifiedTaskMs??s.taskMs),0)/samples.length,
   longestRequestInputTokens:Math.max(0,...calls.map((c:any)=>c.usage?.inputTokens??0)),calls:calls.length,losslessRequests:calls.filter((c:any)=>c.losslessReads>0).length,
   statelessCalls:calls.filter((c:any)=>c.stateless&&!c.previousResponse).length,
   replayedRequests:calls.filter((c:any)=>c.replayedReadHistory).length, completeTraceTasks:samples.filter((s:any)=>s.security?.traceComplete).length, productionTraceMatches:samples.filter((s:any)=>s.productionTraceMatches===true).length, forbiddenAttempts:samples.reduce((n:number,s:any)=>n+(s.security?.forbiddenReadAttempts?.length??0),0), compactions:samples.reduce((n:number,s:any)=>n+(s.compactions??0),0),details:samples.map((s:any)=>({task:s.fixture,files:s.repetition,accepted:!!accepted(s),completed:s.completed,context:s.quality?.context,tests:s.quality?.tests?.passed,security:s.security,readsComplete:s.contextComplete,tokens:s.usage?.totalTokens,taskMs:s.taskMs,gradeError:s.quality?.error}))};
 });
 const pairs=report.plan.flatMap((p:any,i:number)=>{
  if(p.model!==model||p.threshold!==threshold)return[];
  const a=report.records.find((r:any)=>r.pair===i+1&&r.sample.variant==='before')?.sample,b=report.records.find((r:any)=>r.pair===i+1&&r.sample.variant==='after')?.sample;
  if(!a||!b)return[];assert(a.fixtureHash===b.fixtureHash,'Pair fixture drift');
  return[{pair:i+1,task:p.fixture,files:p.repetition,before:a,after:b}];
 });
 const [a,b]=variants;
 return {model,threshold,variants,allAttemptTokenSavingPercent:100*(1-b!.totalTokens/a!.totalTokens),costPerCorrectSavingPercent:a!.usdPerCorrectTask&&b!.usdPerCorrectTask?100*(1-b!.usdPerCorrectTask/a!.usdPerCorrectTask):null,
  latency:pairs.length?pairedSummary(pairs.map((p:any)=>p.before.verifiedTaskMs??p.before.taskMs),pairs.map((p:any)=>p.after.verifiedTaskMs??p.after.taskMs)):null,
  pairs:pairs.map((p:any)=>({pair:p.pair,task:p.task,files:p.files,beforeAccepted:!!accepted(p.before),afterAccepted:!!accepted(p.after),beforeTokens:p.before.usage?.totalTokens,afterTokens:p.after.usage?.totalTokens,beforeVerifiedMs:p.before.verifiedTaskMs,afterVerifiedMs:p.after.verifiedTaskMs}))};
});
const summary={stopReason:report.stopReason,attempts:report.records.length,reportedTokens:report.reportedTokens,groups,estimatedKnownUSD:groups.reduce((n,g)=>n+g.variants.reduce((m,v)=>m+v.estimatedKnownUSD,0),0),pricing:{date:'2026-11-15',source:'https://developers.openai.com/api/docs/pricing',tier:'Standard short context',rates},costDefinition:'All attempts (including failures) divided by accepted completed tasks. Null if no successes or unknown usage. Public-rate estimate, not invoice. Verification latency includes isolated Bun tests.'};
await writeFile(process.argv[3]!,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
