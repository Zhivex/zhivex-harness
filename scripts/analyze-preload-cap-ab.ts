import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mean,median,random} from './benchmarks/paired-statistics.js';
import type {CapSample} from './benchmark-preload-cap-ab.js';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: bun scripts/analyze-preload-cap-ab.ts campaign.json summary.json');
const raw=await readFile(input,'utf8'),c=JSON.parse(raw) as {records:{pair:number;position:number;sample:CapSample}[];plan:{fixture:string;order:string[]}[];reportedTokens:number;stopReason:string;artifacts:unknown};
const rows=c.records.map(r=>r.sample);
const complete=(s:CapSample)=>!!s.completed&&s.calls.length===1&&s.calls[0]?.terminalType==='response.completed';
const pass=(s:CapSample)=>complete(s)&&!!s.correctReads&&!!s.quality?.pass;
const truncated=(s:CapSample)=>s.calls.some(a=>a.terminalType==='response.incomplete'&&a.incompleteReason==='max_output_tokens');
const pairs=c.plan.flatMap((p,i)=>{const a=c.records.find(r=>r.pair===i+1&&r.sample.variant==='2048'),b=c.records.find(r=>r.pair===i+1&&r.sample.variant==='4096');return a&&b?[{id:i+1,fixture:p.fixture,a:a.sample,b:b.sample}]:[];});
type Pair=typeof pairs[number];
function comparison(selected:Pair[],metric:(s:CapSample)=>number|undefined){
 const p=selected.filter(r=>Number.isFinite(metric(r.a))&&Number.isFinite(metric(r.b)));if(!p.length)return null;
 const groups=[...new Set(p.map(r=>r.fixture))].map(f=>p.filter(r=>r.fixture===f));const rng=random(20261118),boot:number[]=[];
 for(let i=0;i<10000;i++){const sample=groups.flatMap(g=>g.map(()=>g[Math.floor(rng()*g.length)]!));boot.push(mean(sample.map(r=>metric(r.b)!-metric(r.a)!)));}boot.sort((a,b)=>a-b);
 const a=p.map(r=>metric(r.a)!),b=p.map(r=>metric(r.b)!);
 return{pairs:p.length,mean2048:mean(a),mean4096:mean(b),median2048:median(a),median4096:median(b),mean4096Minus2048:mean(b)-mean(a),difference95CI:[boot[249],boot[9749]],higher4096Pairs:p.filter(r=>metric(r.b)!>metric(r.a)!).length};
}
function discordance(predicate:(s:CapSample)=>boolean){const only2048=pairs.filter(p=>predicate(p.a)&&!predicate(p.b)).length,only4096=pairs.filter(p=>!predicate(p.a)&&predicate(p.b)).length;const n=only2048+only4096,k=Math.min(only2048,only4096);let term=1,sum=1;for(let i=1;i<=k;i++){term*= (n-i+1)/i;sum+=term;}return{only2048,only4096,both:pairs.filter(p=>predicate(p.a)&&predicate(p.b)).length,neither:pairs.filter(p=>!predicate(p.a)&&!predicate(p.b)).length,exactTwoSidedP:n?Math.min(1,2*sum/2**n):1};}
const total=(s:CapSample,key:'totalTokens'|'outputTokens'|'inputTokens'|'reasoningTokens'|'cachedInputTokens')=>s.calls.length&&s.calls.every(a=>a.usage)?s.calls.reduce((n,a)=>n+a.usage![key],0):undefined;
const variants=Object.fromEntries(['2048','4096'].map(v=>{const r=rows.filter(s=>s.variant===v),calls=r.flatMap(s=>s.calls);return[v,{attempts:r.length,providerComplete:r.filter(complete).length,truncated:r.filter(truncated).length,passed:r.filter(pass).length,functionallyCorrect:r.filter(s=>s.quality?.facts).length,regressionExamplesPassed:r.reduce((n,s)=>n+(s.quality?.regressions??0),0),cachedUsageKnown:calls.every(a=>a.cachedUsageReported),totals:Object.fromEntries((['inputTokens','outputTokens','totalTokens','reasoningTokens','cachedInputTokens'] as const).map(k=>[k,r.reduce((n,s)=>n+(total(s,k)??0),0)])),responses:calls.length,outputsAbove2048:calls.filter(a=>(a.usage?.outputTokens??0)>2048).length,maxOutput:Math.max(...calls.map(a=>a.usage?.outputTokens??0)),sdkUsageMatches:r.filter(s=>s.sdkUsage?.totalTokens===total(s,'totalTokens')).length}];}));
const metrics={wallMs:(s:CapSample)=>s.taskMs,tokens:(s:CapSample)=>total(s,'totalTokens'),reasoning:(s:CapSample)=>total(s,'reasoningTokens'),passRate:(s:CapSample)=>Number(pass(s)),truncationRate:(s:CapSample)=>Number(truncated(s))};
const summary={campaignSha256:createHash('sha256').update(raw).digest('hex'),artifacts:c.artifacts,stopReason:c.stopReason,reportedTokens:c.reportedTokens,attemptedPairs:pairs.length,unpairedAttempts:c.records.filter(r=>!pairs.some(p=>p.id===r.pair)).length,variants,pairedTests:{pass:discordance(pass),truncation:discordance(truncated)},comparisons:Object.fromEntries(Object.entries(metrics).map(([k,f])=>[k,comparison(pairs,f)])),byFixture:Object.fromEntries([...new Set(pairs.map(p=>p.fixture))].map(f=>[f,{wall:comparison(pairs.filter(p=>p.fixture===f),metrics.wallMs),pass:comparison(pairs.filter(p=>p.fixture===f),metrics.passRate),truncation:comparison(pairs.filter(p=>p.fixture===f),metrics.truncationRate)}]))};
await writeFile(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
