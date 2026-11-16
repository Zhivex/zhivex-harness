import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pairedSummary } from './benchmarks/paired-statistics.js';
// Standard short-context rates, USD per million tokens, verified 2026-11-15.
const prices: Record<string, {input:number;output:number;cached:number}> = {
  'gpt-6-luna': {input:0.10, output:0.50, cached:0.01},
  'gpt-6.1-sol': {input:2, output:10, cached:0.10}
};
const report = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const valid = (s:any) => s.completed && s.quality?.passed && s.initialReadOrder && JSON.stringify(s.initialReadTurns) === '[1,1,1,1]' && s.usageMatches && s.calls.length && s.calls.every((c:any) => c.usage && c.terminalType === 'response.completed');
const rows = report.plan.map((p:any) => p.model) as string[];
const groups = [...new Set(rows)].map(model => {
  const price = prices[model]; assert(price, 'Unpriced model');
  const variants = ['before','after'].map(variant => {
    const samples = report.records.filter((r:any) => r.sample.model === model && r.sample.variant === variant).map((r:any) => r.sample);
    const calls = samples.flatMap((s:any) => s.calls);
    const total = (field:string) => calls.reduce((n:number,c:any) => n + (c.usage?.[field] ?? 0), 0);
    const correct = samples.filter(valid).length;
    const unknownCalls = calls.filter((c:any) => !c.usage).length;
    const input = total('inputTokens'), cached = total('cachedInputTokens'), output = total('outputTokens');
    const usd = ((input-cached)*price.input + cached*price.cached + output*price.output)/1e6;
    const tokens = total('totalTokens');
    return {variant, attempts:samples.length, correct, unknownCalls, input, cached, output, tokens,
      estimatedKnownUSD:usd, usdPerCorrectTask:correct && !unknownCalls ? usd/correct : null,
      tokensPerCorrectTask:correct && !unknownCalls ? tokens/correct : null,
      meanTaskMs:samples.reduce((n:number,s:any) => n+s.taskMs,0)/samples.length,
      calls:calls.length, fullHistoryCalls:calls.filter((c:any) => c.stateless && !c.previousResponse).length,
      losslessRequests:calls.filter((c:any) => c.losslessReads>0).length,
      scopedGuidanceCalls:calls.filter((c:any) => c.scopedGuidance).length,
      recoveryCalls:samples.reduce((n:number,s:any)=>n+s.toolResults.filter((r:any)=>r.name==='read_tool_result').length,0),
      compactions:samples.reduce((n:number,s:any)=>n+s.compactions,0)};
  });
  const pairs = report.plan.flatMap((p:any,i:number) => {
    if(p.model !== model) return [];
    const before = report.records.find((r:any)=>r.pair===i+1 && r.sample.variant==='before')?.sample;
    const after = report.records.find((r:any)=>r.pair===i+1 && r.sample.variant==='after')?.sample;
    return before && after ? [{pair:i+1, before, after}] : [];
  });
  const [before,after]=variants;
  return {model,variants, tokenSavingPercent:100*(1-after!.tokens/before!.tokens), costSavingPercent:100*(1-after!.estimatedKnownUSD/before!.estimatedKnownUSD),
    latency:pairedSummary(pairs.map((p:any)=>p.before.taskMs),pairs.map((p:any)=>p.after.taskMs)),
    everyPairSavesTokens:pairs.every((p:any)=>p.after.usage.totalTokens<p.before.usage.totalTokens),
    qualityRegressions:pairs.filter((p:any)=>valid(p.before)&&!valid(p.after)).map((p:any)=>p.pair)};
});
const result={schemaVersion:1,source:process.argv[2],stopReason:report.stopReason,pricing:{date:'2026-11-15',source:'https://developers.openai.com/api/docs/pricing',tier:'Standard short context',prices},
  costDefinition:'Sum of ALL attempt usage cost (including failures) divided by tasks passing exact context/quality, completion, tool-order and usage checks. Null when no successes or unknown receipts. Reasoning is already included in output. USD is a public-rate estimate, not an invoice.',
  groups,estimatedCampaignUSD:groups.reduce((n,g)=>n+g.variants.reduce((m,v)=>m+v.estimatedKnownUSD,0),0)};
await writeFile(process.argv[3]!,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
