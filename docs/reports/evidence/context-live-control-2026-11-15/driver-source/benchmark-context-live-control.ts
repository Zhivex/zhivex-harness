import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createContextLiveMeter } from './benchmarks/context-live/meter.js';
import { grade } from './benchmarks/context-live/fixtures.js';
import { sanitizeOperationalError } from './release-diagnostics.js';
assert(process.argv.includes('--live') && process.env.OPENAI_API_KEY);
const get = (name: string) => { const i = process.argv.indexOf(name); assert(i > 0); return process.argv[i + 1]!; };
const directory = path.resolve(get('--directory')), runtimes = path.resolve(get('--runtimes'));
await mkdir(directory);
const expected = { code: 'CONTROL-27-B', total: 1125, threshold: 1122, decision: 'hold', policy: 'bun-only', revision: 2 };
const padding = Array.from({ length: 75 }, (_, i) => `Archived diagnostic ${i}: ordinary inactive tracing records; no authoritative contractual values or operational instructions on this line.`).join('\n');
const files = { 'src/AGENTS.md': 'The dossier JSON policy field must be "bun-only". Do not edit files.',
  'src/01.txt': 'AUTHORITATIVE: code=CONTROL-27-B; base=137.\n' + padding,
  'src/02.txt': 'AUTHORITATIVE: adjustment=29; multiplier=8; total=base*multiplier+adjustment.\n' + padding,
  'src/03.txt': 'FINAL revision=2: threshold=1122. Decision is release iff total <= threshold, otherwise hold.' };
const prompt = 'Read src/01.txt, src/02.txt and src/03.txt completely, in that order, one file per tool turn. Do not edit files. Then return only JSON with exactly code,total,threshold,decision,policy,revision. Use facts from all files and the project guidance. No intermediate summaries are needed.';
const plan = ['gpt-6-luna', 'gpt-6.1-sol'].map((model, i) => ({ model, order: i ? ['after', 'before'] : ['before', 'after'] }));
const report: Record<string, any> = { schemaVersion: 1, stateless: true, compaction: false, startedAt: new Date().toISOString(),
  tokenBudget: 65000, reservePerPair: 40000, maxTaskTokens: 20000, methodology: 'Separate positive control: two model pairs, opposite orders. Facts in preserved leading excerpts, three sequential reads. Compaction disabled equally to isolate projection. Not pooled with the middle-context stress test.',
  fixtureHash: createHash('sha256').update(JSON.stringify({ files, prompt, expected })).digest('hex'), expected, plan, records: [], reportedTokens: 0, stopReason: 'running' };
const save = () => writeFile(path.join(directory, 'campaign.json'), JSON.stringify(report, null, 2) + '\n');
await save();
outer: for (const [i, item] of plan.entries()) {
  if (report.reportedTokens + report.reservePerPair > report.tokenBudget) { report.stopReason = 'token-reserve'; break; }
  for (const variant of item.order) {
    const runtimePath = path.join(runtimes, `${variant}.mjs`);
    const runtime = await import(pathToFileURL(runtimePath).href) as typeof import('../packages/core/src/runtime/harness.js');
    const root = await mkdtemp('/tmp/context-live-control-');
    const sample: Record<string, any> = { model: item.model, variant, fixture: 'leading-context-control', repetition: 0,
      runtimeHash: createHash('sha256').update(await readFile(runtimePath)).digest('hex'), completed: false };
    const nativeFetch = globalThis.fetch, meter = createContextLiveMeter(nativeFetch, item.model, 'low', () => performance.now(), 1024, true, 5, undefined, true);
    let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined, start: number | undefined;
    try {
      await mkdir(root + '/src'); for (const [p, v] of Object.entries(files)) await writeFile(root + '/' + p, v);
      globalThis.fetch = meter.fetch;
      harness = await runtime.createHarness({ workspace: root, provider: 'openai', model: item.model, env: process.env, reasoningEffort: 'low',
        toolNames: ['read_file', 'read_tool_result', 'discover_tools'], subagentProfiles: [], maxSteps: 5,
        maxInputTokens: 16000, maxOutputTokens: 4000, maxTotalTokens: 20000 });
      meter.start(); start = performance.now();
      const result = await runtime.runHarnessTask(harness, { prompt, compaction: false, maxSteps: 5, maxTokens: 1024, maxRetries: 0,
        providerOptions: { apiMode: 'responses', store: false }, abortSignal: AbortSignal.timeout(120000) }, { onTaskTelemetry: t => { sample.telemetry = t; } });
      sample.taskMs = performance.now() - start; sample.status = result.status; sample.completed = result.status === 'completed';
      sample.answer = result.outputText; sample.quality = grade(result.outputText, expected); sample.sdkUsage = result.usage;
      sample.compactions = result.state.compactions?.length ?? 0;
      sample.toolResults = result.toolResults.map(r => ({ name: r.toolName, failed: !!r.isError, path: (r.output as any)?.path }));
      sample.initialReadOrder = JSON.stringify(sample.toolResults.filter((r: any) => r.name === 'read_file' && !r.failed).slice(0, 3).map((r: any) => r.path)) === JSON.stringify(['src/01.txt', 'src/02.txt', 'src/03.txt']);
      if (result.error) sample.failure = sanitizeOperationalError(result.error);
    } catch (error) { sample.failure = sanitizeOperationalError(error); }
    finally {
      if (start !== undefined) sample.taskMs ??= performance.now() - start;
      sample.calls = meter.snapshot(); sample.quality ??= { passed: false };
      if (sample.calls.length && sample.calls.every((c: any) => c.usage)) sample.usage = sample.calls.reduce((sum: any, c: any) => {
        for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens']) sum[key] = (sum[key] ?? 0) + c.usage[key]; return sum;
      }, {});
      sample.usageMatches = sample.usage?.totalTokens === sample.sdkUsage?.totalTokens;
      globalThis.fetch = nativeFetch; await harness?.close(); await rm(root, { recursive: true, force: true });
    }
    report.records.push({ pair: i + 1, sample });
    report.reportedTokens += sample.calls.reduce((sum: number, c: any) => sum + (c.usage?.totalTokens ?? 0), 0);
    await writeFile(path.join(directory, `pair-${i + 1}-${variant}.json`), JSON.stringify(sample, null, 2) + '\n'); await save();
    console.log(JSON.stringify({ model: item.model, variant, completed: sample.completed, quality: sample.quality.passed, tokens: sample.usage?.totalTokens, taskMs: sample.taskMs }));
    if (!sample.usage) { report.stopReason = 'unknown-usage'; break outer; }
    if (sample.usage.totalTokens > 20000 || report.reportedTokens > 65000) { report.stopReason = 'token-budget'; break outer; }
  }
}
if (report.stopReason === 'running') report.stopReason = 'planned-completion';
report.finishedAt = new Date().toISOString(); await save();
