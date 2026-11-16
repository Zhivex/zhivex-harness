import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pairedSummary } from './benchmarks/paired-statistics.js';
const report = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const sum = (items: any[], key: string) => items.reduce((n, s) => n + s.calls.reduce((m: number, c: any) => m + (c.usage?.[key] ?? 0), 0), 0);
const valid = (s: any) => s.completed && s.quality?.passed && s.initialReadOrder &&
  (!s.initialReadTurns || JSON.stringify(s.initialReadTurns) === '[1,1,1,1]') && s.calls.every((c: any) => c.terminalType === 'response.completed');
const groups = [...new Set<string>(report.plan.map((p: any) => p.model))].map(model => {
  const records = report.records.filter((r: any) => r.sample.model === model);
  const rows = ['before', 'after'].map(variant => {
    const samples = records.filter((r: any) => r.sample.variant === variant).map((r: any) => r.sample);
    return { variant, tasks: samples.length, correct: samples.filter(valid).length, completed: samples.filter((s: any) => s.completed).length,
      knownUsage: samples.filter((s: any) => s.usage).length, usageMatches: samples.filter((s: any) => s.usageMatches).length,
      inputTokens: sum(samples, 'inputTokens'), outputTokens: sum(samples, 'outputTokens'), totalTokens: sum(samples, 'totalTokens'),
      cachedInputTokens: sum(samples, 'cachedInputTokens'), uncachedInputTokens: sum(samples, 'inputTokens') - sum(samples, 'cachedInputTokens'),
      reasoningTokens: sum(samples, 'reasoningTokens'), projectedRequests: samples.reduce((n: number, s: any) => n + s.calls.filter((c: any) => c.projections > 0).length, 0),
      calls: samples.reduce((n: number, s: any) => n + s.calls.length, 0),
      compactions: samples.reduce((n: number, s: any) => n + (s.compactions ?? 0), 0),
      recoveryCalls: samples.reduce((n: number, s: any) => n + (s.toolResults ?? []).filter((r: any) => r.name === 'read_tool_result').length, 0),
      totalTaskMs: samples.reduce((n: number, s: any) => n + (s.taskMs ?? 0), 0),
      contextMs: samples.reduce((n: number, s: any) => n + (s.telemetry?.operationTotals.context.durationMs ?? 0), 0),
      qualityFields: samples.map((s: any) => ({ fixture: s.fixture, repetition: s.repetition, passed: valid(s), fields: s.quality?.fields ?? {} })) };
  });
  const pairs = report.plan.flatMap((p: any, index: number) => {
    if (p.model !== model) return [];
    const a = records.find((r: any) => r.pair === index + 1 && r.sample.variant === 'before')?.sample;
    const b = records.find((r: any) => r.pair === index + 1 && r.sample.variant === 'after')?.sample;
    return a && b ? [{ pair: index + 1, fixture: p.fixture, repetition: p.repetition, before: a, after: b }] : [];
  });
  const before = rows[0]!, after = rows[1]!;
  return { model, variants: rows, pairedTasks: pairs.length,
    inputReductionPercent: before.inputTokens ? 100 * (1 - after.inputTokens / before.inputTokens) : null,
    totalTokenReductionPercent: before.totalTokens ? 100 * (1 - after.totalTokens / before.totalTokens) : null,
    latency: pairs.length ? pairedSummary(pairs.map((p: any) => p.before.taskMs), pairs.map((p: any) => p.after.taskMs)) : null,
    qualityRegressions: pairs.filter((p: any) => valid(p.before) && !valid(p.after)).map((p: any) => p.pair),
    pairs: pairs.map((p: any) => ({ pair: p.pair, fixture: p.fixture, repetition: p.repetition, beforeCorrect: valid(p.before), afterCorrect: valid(p.after),
      beforeTokens: p.before.usage?.totalTokens ?? null, afterTokens: p.after.usage?.totalTokens ?? null, beforeMs: p.before.taskMs, afterMs: p.after.taskMs })) };
});
const summary = { schemaVersion: 1, stateless: report.stateless ?? false, stopReason: report.stopReason, plannedPairs: report.plan.length,
  attemptedTasks: report.records.length, reportedTokens: report.reportedTokens, groups,
  caveats: ['Small paired sample; latency confidence intervals are descriptive, not production certification.',
    'Fresh cache routing keys do not guarantee zero cache hits: reported cached usage is retained.',
    'Failed tasks and extra recovery calls remain in all-attempt totals; no retries.',
    'Task latency includes context/tool/persistence work; network/provider variance dominates millisecond local changes.',
    'Exact fixture grading checks selected context, not universal semantic quality.'] };
assert(summary.reportedTokens === report.records.reduce((n: number, r: any) => n + r.sample.calls.reduce((s: number, c: any) => s + (c.usage?.totalTokens ?? 0), 0), 0));
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
