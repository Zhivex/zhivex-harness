import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mean, median, pairedSummary } from "./benchmarks/paired-statistics.js";

const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error("Usage: bun scripts/analyze-openai-latency.ts campaign.json summary.json");
const raw = await readFile(input, "utf8");
interface Usage { totalTokens: number; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number }
interface Row {
  pair: number; variant: "baseline" | "candidate"; position: number;
  sample: { valid?: boolean; status?: string; taskMs?: number; activityMs?: number; outputWords?: number; requests?: number;
    transportHeadersMs?: number; transportUsage?: Usage; usage?: Usage;
    meteredResponses?: number; incompleteResponses?: number; responseLimits?: number[];
    telemetry?: { milestones: Record<string, number>; operationTotals: Record<string, { durationMs: number }> } };
}
const campaign = JSON.parse(raw) as { records: Row[]; pairs: number; stopReason: string; reportedTokens: number; artifacts: unknown; model: string };
const pairs: Array<{ pair: number; baseline: Row; candidate: Row }> = [];
for (let pair = 1; pair <= campaign.pairs; pair++) {
  const baseline = campaign.records.find(r => r.pair === pair && r.variant === "baseline");
  const candidate = campaign.records.find(r => r.pair === pair && r.variant === "candidate");
  if (baseline?.sample.valid && candidate?.sample.valid && typeof baseline.sample.taskMs === "number" && typeof candidate.sample.taskMs === "number") {
    pairs.push({ pair, baseline, candidate });
  }
}
const metrics: Record<string, (row: Row) => number | undefined> = {
  task: row => row.sample.taskMs,
  activityHandler: row => row.sample.activityMs,
  firstText: row => row.sample.telemetry?.milestones["first-text-event"],
  responseHeaders: row => row.sample.transportHeadersMs,
  modelStreamIncludingConsumer: row => row.sample.telemetry?.operationTotals.model?.durationMs
};
const comparisons = Object.fromEntries(Object.entries(metrics).map(([key, select]) => {
  const complete = pairs.filter(p => Number.isFinite(select(p.baseline)) && Number.isFinite(select(p.candidate)));
  return [key, complete.length ? pairedSummary(complete.map(p => select(p.baseline)!), complete.map(p => select(p.candidate)!)) : null];
}));
const byOrder = [0, 1].map(position => {
  const selected = pairs.filter(p => p.baseline.position === position);
  return { baselinePosition: position, comparison: selected.length ? pairedSummary(selected.map(p => p.baseline.sample.taskMs!), selected.map(p => p.candidate.sample.taskMs!)) : null };
});
const variants = Object.fromEntries(["baseline", "candidate"].map(variant => {
  const rows = campaign.records.filter(r => r.variant === variant);
  const usage = rows.map(r => r.sample.transportUsage ?? r.sample.usage).filter((u): u is Usage => !!u);
  return [variant, { attempts: rows.length, valid: rows.filter(r => r.sample.valid).length,
    requests: rows.reduce((sum, r) => sum + (r.sample.requests ?? 0), 0),
    meteredResponses: rows.reduce((sum, r) => sum + (r.sample.meteredResponses ?? 0), 0),
    incompleteResponses: rows.reduce((sum, r) => sum + (r.sample.incompleteResponses ?? 0), 0),
    sdkTransportUsageAgreement: rows.filter(r => r.sample.usage?.totalTokens === r.sample.transportUsage?.totalTokens).length,
    responseTokenCaps: [...new Set(rows.flatMap(r => r.sample.responseLimits ?? []))],
    inputTokens: usage.reduce((sum, u) => sum + u.inputTokens, 0), outputTokens: usage.reduce((sum, u) => sum + u.outputTokens, 0),
    totalTokens: usage.reduce((sum, u) => sum + u.totalTokens, 0), cachedInputTokens: usage.reduce((sum, u) => sum + (u.cachedInputTokens ?? 0), 0),
    meanReasoningTokens: usage.length ? mean(usage.map(u => u.reasoningTokens ?? 0)) : null,
    medianOutputWords: rows.some(r => r.sample.outputWords) ? median(rows.flatMap(r => r.sample.outputWords === undefined ? [] : [r.sample.outputWords])) : null }];
}));
const result = { schemaVersion: 1, campaignSha256: createHash("sha256").update(raw).digest("hex"), model: campaign.model,
  artifacts: campaign.artifacts, plannedPairs: campaign.pairs, completePairs: pairs.length,
  excludedPairs: Array.from({ length: campaign.pairs }, (_, i) => i + 1).filter(i => !pairs.some(p => p.pair === i)),
  stopReason: campaign.stopReason, reportedTokens: campaign.reportedTokens, variants, comparisons, byOrder,
  pairedTaskTimes: pairs.map(p => ({ pair: p.pair, baselineFirst: p.baseline.position === 0,
    baselineMs: p.baseline.sample.taskMs, candidateMs: p.candidate.sample.taskMs })) };
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ completePairs: pairs.length, reportedTokens: campaign.reportedTokens, task: comparisons.task }, null, 2));
