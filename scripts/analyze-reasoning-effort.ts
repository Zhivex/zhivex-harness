import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mean, median, random } from "./benchmarks/paired-statistics.js";
import type { ReasoningSample } from "./benchmark-reasoning-effort.js";

const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error("Usage: bun scripts/analyze-reasoning-effort.ts campaign.json summary.json");
const raw = await readFile(input, "utf8");
const campaign = JSON.parse(raw) as { artifacts: unknown; plan: { fixture: string; order: string[] }[];
  records: { pair: number; position: number; sample: ReasoningSample }[]; reportedTokens: number; stopReason: string };
type Pair = { pair: number; fixture: string; default: ReasoningSample; low: ReasoningSample; defaultFirst: boolean };
const pairs: Pair[] = [];
for (let pair = 1; pair <= campaign.plan.length; pair++) {
  const a = campaign.records.find(r => r.pair === pair && r.sample.effort === "default");
  const b = campaign.records.find(r => r.pair === pair && r.sample.effort === "low");
  if (a?.sample.completed && b?.sample.completed && a.sample.taskMs !== undefined && b.sample.taskMs !== undefined) {
    pairs.push({ pair, fixture: a.sample.fixture, default: a.sample, low: b.sample, defaultFirst: a.position === 0 });
  }
}
function comparison(selected: Pair[], metric: (sample: ReasoningSample) => number | undefined) {
  const complete = selected.filter(p => Number.isFinite(metric(p.default)) && Number.isFinite(metric(p.low)));
  if (!complete.length) return null;
  const groups = [...new Set(complete.map(p => p.fixture))].map(f => complete.filter(p => p.fixture === f));
  const rng = random(20261114), bootstrap: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const resampled = groups.flatMap(group => group.map(() => group[Math.floor(rng() * group.length)]!));
    bootstrap.push(mean(resampled.map(p => metric(p.default)! - metric(p.low)!)));
  }
  bootstrap.sort((a, b) => a - b);
  const before = complete.map(p => metric(p.default)!), after = complete.map(p => metric(p.low)!);
  return { pairs: complete.length, defaultMean: mean(before), lowMean: mean(after), defaultMedian: median(before), lowMedian: median(after),
    meanReduction: mean(before) - mean(after), reduction95CI: [bootstrap[249]!, bootstrap[9749]!],
    lowSmallerPairs: complete.filter(p => metric(p.low)! < metric(p.default)!).length };
}
const total = (s: ReasoningSample, key: "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cachedInputTokens") => s.calls.reduce((sum, c) => sum + (c.usage?.[key] ?? 0), 0);
const metrics = {
  taskMs: (s: ReasoningSample) => s.taskMs,
  firstTextMs: (s: ReasoningSample) => s.telemetry?.milestones["first-text-event"],
  activityMs: (s: ReasoningSample) => s.activityMs,
  toolMs: (s: ReasoningSample) => s.telemetry?.operationTotals.tool.durationMs,
  totalTokens: (s: ReasoningSample) => total(s, "totalTokens"),
  reasoningTokens: (s: ReasoningSample) => total(s, "reasoningTokens")
};
const variants = Object.fromEntries(["default", "low"].map(effort => {
  const rows = campaign.records.map(r => r.sample).filter(s => s.effort === effort);
  const quality = (selected: ReasoningSample[]) => ({ attempts: selected.length, completed: selected.filter(s => s.completed).length,
    facts: selected.filter(s => s.quality?.facts).length, format: selected.filter(s => s.quality?.format).length,
    length: selected.filter(s => s.quality?.length).length, correctReads: selected.filter(s => s.correctReads).length,
    allCriteria: selected.filter(s => s.completed && s.correctReads && s.quality?.pass && s.calls.every(c => c.terminalType === "response.completed")).length });
  return [effort, { ...quality(rows), byFixture: Object.fromEntries([...new Set(rows.map(s => s.fixture))].map(f => [f, quality(rows.filter(s => s.fixture === f))])),
    requests: rows.reduce((sum, s) => sum + s.calls.length, 0), meteredResponses: rows.reduce((sum, s) => sum + s.calls.filter(c => c.usage).length, 0),
    totals: Object.fromEntries((["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const).map(k => [k, rows.reduce((sum, s) => sum + total(s, k), 0)])),
    requestedEfforts: [...new Set(rows.flatMap(s => s.calls.map(c => c.requestedEffort)))], returnedEfforts: [...new Set(rows.flatMap(s => s.calls.map(c => c.returnedEffort ?? "unknown")))],
    returnedModels: [...new Set(rows.flatMap(s => s.calls.map(c => c.returnedModel ?? "unknown")))],
    toolCounts: [...new Set(rows.map(s => s.telemetry?.operationTotals.tool.count))],
    sdkUsageMatches: rows.filter(s => s.sdkUsage?.totalTokens === total(s, "totalTokens")).length }];
}));
const callMetrics = Object.fromEntries([0, 1].map(index => [String(index + 1), Object.fromEntries([
  ["headersMs", (s: ReasoningSample) => s.calls[index]?.headersMs],
  ["firstEventMs", (s: ReasoningSample) => s.calls[index]?.firstEventMs],
  ["firstTextMs", (s: ReasoningSample) => s.calls[index]?.firstTextMs],
  ["firstToolEventMs", (s: ReasoningSample) => s.calls[index]?.firstToolEventMs],
  ["terminalMs", (s: ReasoningSample) => s.calls[index]?.terminalMs],
  ["reasoningTokens", (s: ReasoningSample) => s.calls[index]?.usage?.reasoningTokens]
].map(([name, metric]) => [name as string, comparison(pairs, metric as (s: ReasoningSample) => number | undefined)]))]));
const summary = { schemaVersion: 1, campaignSha256: createHash("sha256").update(raw).digest("hex"), artifacts: campaign.artifacts,
  stopReason: campaign.stopReason, reportedTokens: campaign.reportedTokens, completePairs: pairs.length,
  excludedPairs: campaign.plan.map((_, i) => i + 1).filter(i => !pairs.some(p => p.pair === i)), variants,
  comparisons: Object.fromEntries(Object.entries(metrics).map(([key, select]) => [key, comparison(pairs, select)])),
  byFixture: Object.fromEntries([...new Set(pairs.map(p => p.fixture))].map(f => [f, comparison(pairs.filter(p => p.fixture === f), metrics.taskMs)])),
  byOrder: [true, false].map(first => ({ defaultFirst: first, task: comparison(pairs.filter(p => p.defaultFirst === first), metrics.taskMs) })), callMetrics };
await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ completePairs: pairs.length, reportedTokens: campaign.reportedTokens, comparisons: summary.comparisons, variants }, null, 2));
