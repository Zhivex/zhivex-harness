import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {RecoverySample} from './benchmark-preload-recovery.js';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: bun scripts/analyze-preload-recovery.ts campaign.json summary.json');
const raw=await readFile(input,'utf8');const c=JSON.parse(raw) as {reportedTokens:number;tokenBudget:number;stopReason:string;sourceSha256:string;artifacts:unknown;baseline:{pair:number;sample:RecoverySample;quality:{pass:boolean};validationMs:number}[];records:{pair:number;exit:number|null;sample:RecoverySample}[]};
const tokens=(s:RecoverySample)=>s.calls.reduce((n,a)=>n+(a.usage?.totalTokens??0),0);
const delivered=(s:RecoverySample)=>!!s.completed&&s.calls.length===1&&s.calls[0]!.terminalType==='response.completed';
const passed=(s:RecoverySample)=>delivered(s)&&!!s.correctReads&&!!s.quality?.pass;
const perTask=c.baseline.map(b=>{const retry=c.records.find(r=>r.pair===b.pair);const oldPass=delivered(b.sample)&&!!b.sample.correctReads&&b.quality.pass;
 const extraMs=retry?(retry.sample.taskMs??0)+(retry.sample.validationMs??0):0;
 return {pair:b.pair,retried:!!retry,baselinePass:oldPass,recovered:!!retry&&passed(retry.sample),finalPass:oldPass||!!retry&&passed(retry.sample),additionalChecks:retry?.sample.additional??null,
 baselineTokens:tokens(b.sample),retryTokens:retry?tokens(retry.sample):0,totalTokens:tokens(b.sample)+(retry?tokens(retry.sample):0),
 baselineModelWallMs:b.sample.taskMs??0,baselineValidationMs:b.validationMs,baselineValidatedWallMs:(b.sample.taskMs??0)+b.validationMs,
 incrementalRetryMs:extraMs,totalValidatedWallMs:(b.sample.taskMs??0)+b.validationMs+extraMs,
 diagnostic:retry?.sample.diagnostic??null,diagnosticMs:retry?.sample.diagnosticMs??null,terminalType:retry?.sample.calls[0]?.terminalType??null};});
const sum=(key:'baselineTokens'|'retryTokens'|'totalTokens'|'baselineValidatedWallMs'|'incrementalRetryMs'|'totalValidatedWallMs')=>perTask.reduce((n,t)=>n+t[key],0);
const calls=c.records.flatMap(r=>r.sample.calls);
const summary={sourceSha256:c.sourceSha256,campaignSha256:createHash('sha256').update(raw).digest('hex'),artifacts:c.artifacts,design:'Retrospective single retry on two frozen failures; cumulative times reconstructed, not fresh paired trial.',stopReason:c.stopReason,
 attempts:c.records.length,recovered:perTask.filter(t=>t.recovered).length,baselinePasses:perTask.filter(t=>t.baselinePass).length,finalPasses:perTask.filter(t=>t.finalPass).length,cohortSize:perTask.length,
 budget:c.tokenBudget,newReportedTokens:c.reportedTokens,baselineTokens:sum('baselineTokens'),cumulativeTokens:sum('totalTokens'),
 baselineMeanValidatedMs:sum('baselineValidatedWallMs')/perTask.length,cumulativeMeanValidatedMs:sum('totalValidatedWallMs')/perTask.length,addedMeanMsPerOriginalTask:sum('incrementalRetryMs')/perTask.length,
 retryMeanMs:c.records.length?sum('incrementalRetryMs')/c.records.length:null,
 providerCompleteRetries:c.records.filter(r=>delivered(r.sample)).length,truncatedRetries:calls.filter(a=>a.terminalType==='response.incomplete').length,
 coldCacheVerified:calls.length===c.records.length&&calls.every(a=>a.cachedUsageReported&&a.usage?.cachedInputTokens===0),uniqueCacheKeys:new Set(calls.map(a=>a.cacheKeyHash)).size,
 retrySdkUsageMatches:c.records.filter(r=>r.sample.sdkUsage?.totalTokens===tokens(r.sample)).length,perTask};
await writeFile(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
