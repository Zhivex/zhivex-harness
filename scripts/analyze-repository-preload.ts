import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mean, median, random } from "./benchmarks/paired-statistics.js";
import type { RepositoryPreloadSample } from "./benchmark-repository-preload.js";

const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error("Usage: bun scripts/analyze-repository-preload.ts campaign.json summary.json");
const raw = await readFile(input, "utf8");
const campaign = JSON.parse(raw) as { artifacts: unknown; plan: { fixture: string; order: string[] }[];
  records: { pair: number; position: number; sample: RepositoryPreloadSample }[]; reportedTokens: number; stopReason: string };
type Pair = { pair: number; fixture: string; tool: RepositoryPreloadSample; preload: RepositoryPreloadSample; toolFirst: boolean };
const pairs: Pair[] = [];
for (let pair = 1; pair <= campaign.plan.length; pair++) {
  const a = campaign.records.find(r => r.pair === pair && r.sample.variant === "tool");
  const b = campaign.records.find(r => r.pair === pair && r.sample.variant === "preload");
  if (a?.sample.completed && b?.sample.completed && a.sample.taskMs !== undefined && b.sample.taskMs !== undefined) {
    pairs.push({ pair, fixture: a.sample.fixture, tool: a.sample, preload: b.sample, toolFirst: a.position === 0 });
  }
}
function comparison(selected: Pair[], metric: (sample: RepositoryPreloadSample) => number | undefined) {
  const complete = selected.filter(p => Number.isFinite(metric(p.tool)) && Number.isFinite(metric(p.preload)));
  if (!complete.length) return null;
  const groups = [...new Set(complete.map(p => p.fixture))].map(f => complete.filter(p => p.fixture === f));
  const rng = random(20261114), bootstrap: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const resampled = groups.flatMap(group => group.map(() => group[Math.floor(rng() * group.length)]!));
    bootstrap.push(mean(resampled.map(p => metric(p.tool)! - metric(p.preload)!)));
  }
  bootstrap.sort((a, b) => a - b);
  const before = complete.map(p => metric(p.tool)!), after = complete.map(p => metric(p.preload)!);
  return { pairs: complete.length, toolMean: mean(before), preloadMean: mean(after), toolMedian: median(before), preloadMedian: median(after),
    meanReduction: mean(before) - mean(after), reduction95CI: [bootstrap[249]!, bootstrap[9749]!],
    preloadSmallerPairs: complete.filter(p => metric(p.preload)! < metric(p.tool)!).length };
}
const total = (s: RepositoryPreloadSample, key: "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cachedInputTokens") => s.calls.reduce((sum, c) => sum + (c.usage?.[key] ?? 0), 0);
const metrics = {
  taskMs: (s: RepositoryPreloadSample) => s.taskMs,
  firstTextMs: (s: RepositoryPreloadSample) => s.telemetry?.milestones["first-text-event"] === undefined ? undefined : s.telemetry.milestones["first-text-event"] + (s.runOffsetMs ?? 0),
  activityMs: (s: RepositoryPreloadSample) => s.activityMs,
  toolMs: (s: RepositoryPreloadSample) => s.telemetry?.operationTotals.tool.durationMs,
  totalTokens: (s: RepositoryPreloadSample) => total(s, "totalTokens"),
  reasoningTokens: (s: RepositoryPreloadSample) => total(s, "reasoningTokens")
};
const variants = Object.fromEntries(["tool", "preload"].map(variant => {
  const rows = campaign.records.map(r => r.sample).filter(s => s.variant === variant);
  const quality = (selected: RepositoryPreloadSample[]) => ({ attempts: selected.length, completed: selected.filter(s => s.completed).length,
    facts: selected.filter(s => s.quality?.facts).length, format: selected.filter(s => s.quality?.format).length,
    length: selected.filter(s => s.quality?.length).length, correctReads: selected.filter(s => s.correctReads).length,
    allCriteria: selected.filter(s => s.completed && s.correctReads && s.quality?.pass && s.calls.every(c => c.terminalType === "response.completed")).length });
  return [variant, { ...quality(rows), byFixture: Object.fromEntries([...new Set(rows.map(s => s.fixture))].map(f => [f, quality(rows.filter(s => s.fixture === f))])),
    requests: rows.reduce((sum, s) => sum + s.calls.length, 0), meteredResponses: rows.reduce((sum, s) => sum + s.calls.filter(c => c.usage).length, 0),
    totals: Object.fromEntries((["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const).map(k => [k, rows.reduce((sum, s) => sum + total(s, k), 0)])),
    requestedEfforts: [...new Set(rows.flatMap(s => s.calls.map(c => c.requestedEffort)))], returnedEfforts: [...new Set(rows.flatMap(s => s.calls.map(c => c.returnedEffort ?? "unknown")))],
    returnedModels: [...new Set(rows.flatMap(s => s.calls.map(c => c.returnedModel ?? "unknown")))],
    toolCounts: [...new Set(rows.map(s => s.telemetry?.operationTotals.tool.count))],
    sdkUsageMatches: rows.filter(s => s.sdkUsage?.totalTokens === total(s, "totalTokens")).length }];
}));
const callMetrics = Object.fromEntries(["first", "final"].map(position => [position, Object.fromEntries([
  ["headersMs", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.headersMs],
  ["firstEventMs", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.firstEventMs],
  ["firstTextMs", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.firstTextMs],
  ["firstToolEventMs", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.firstToolEventMs],
  ["terminalMs", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.terminalMs],
  ["reasoningTokens", (s: RepositoryPreloadSample) => s.calls[position === "first" ? 0 : s.calls.length - 1]?.usage?.reasoningTokens]
].map(([name, metric]) => [name as string, comparison(pairs, metric as (s: RepositoryPreloadSample) => number | undefined)]))]));
const summary = { schemaVersion: 1, campaignSha256: createHash("sha256").update(raw).digest("hex"), artifacts: campaign.artifacts,
  stopReason: campaign.stopReason, reportedTokens: campaign.reportedTokens, completePairs: pairs.length,
  excludedPairs: campaign.plan.map((_, i) => i + 1).filter(i => !pairs.some(p => p.pair === i)), variants,
  comparisons: Object.fromEntries(Object.entries(metrics).map(([key, select]) => [key, comparison(pairs, select)])),
  byFixture: Object.fromEntries([...new Set(pairs.map(p => p.fixture))].map(f => [f, comparison(pairs.filter(p => p.fixture === f), metrics.taskMs)])),
  byOrder: [true, false].map(first => ({ toolFirst: first, task: comparison(pairs.filter(p => p.toolFirst === first), metrics.taskMs) })), callMetrics };
await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ completePairs: pairs.length, reportedTokens: campaign.reportedTokens, comparisons: summary.comparisons, variants }, null, 2));
