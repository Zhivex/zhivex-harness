import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContextLiveMeter } from './benchmarks/context-live/meter.js';
import { fixture, fixtures, grade } from './benchmarks/context-live/fixtures.js';
import { sanitizeOperationalError } from './release-diagnostics.js';
const arg = (name: string) => { const at = process.argv.indexOf(name); assert(at > 0 && process.argv[at + 1], `Missing ${name}`); return process.argv[at + 1]!; };
const models = ['gpt-6-luna', 'gpt-6.1-sol'];
const stateless = process.argv.includes('--stateless');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function worker() {
  const model = arg('--model'), variant = arg('--variant'), output = arg('--output'), runtimePath = path.resolve(arg('--runtime'));
  assert(models.includes(model)); assert(['before', 'after'].includes(variant));
  const name = arg('--fixture') as typeof fixtures[number]; assert(fixtures.includes(name));
  const repetition = Number(arg('--repetition')); const data = fixture(name, repetition);
  const runtime = await import(pathToFileURL(runtimePath).href) as typeof import('../packages/core/src/runtime/harness.js');
  const root = await mkdtemp('/tmp/context-live-task-');
  const sample: Record<string, any> = { model, variant, fixture: name, repetition, fixtureHash: data.hash, bun: Bun.version, runtimeHash: hash(await readFile(runtimePath)), stateless, expected: data.expected, completed: false };
  const nativeFetch = globalThis.fetch;
  const meter = createContextLiveMeter(nativeFetch, model, 'low', () => performance.now(), 2048, true, 8, undefined, stateless);
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined, started: number | undefined;
  try {
    for (const [file, contents] of Object.entries(data.files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), contents); }
    globalThis.fetch = meter.fetch;
    harness = await runtime.createHarness({ workspace: root, provider: 'openai', model, env: process.env,
      reasoningEffort: 'low', toolNames: ['read_file', 'read_tool_result', 'discover_tools'], subagentProfiles: [], maxSteps: 8,
      unlimitedTokens: false, maxInputTokens: 52000, maxOutputTokens: 8000, maxTotalTokens: 60000,
      compactionMaxEstimatedInputTokens: 14000 });
    meter.start(); started = performance.now();
    const result = await runtime.runHarnessTask(harness, { prompt: data.prompt, maxSteps: 8, maxTokens: 2048, maxRetries: 0,
      providerOptions: { apiMode: 'responses', ...(stateless ? { store: false } : {}) }, abortSignal: AbortSignal.timeout(180_000) }, {
      onTaskTelemetry: telemetry => { sample.telemetry = telemetry; }
    });
    sample.taskMs = performance.now() - started;
    sample.status = result.status; sample.completed = result.status === 'completed'; sample.answer = result.outputText;
    sample.quality = grade(result.outputText, data.expected); sample.sdkUsage = result.usage;
    sample.compactions = result.state.compactions?.length ?? 0;
    sample.toolResults = result.toolResults.map(r => ({ name: r.toolName, failed: !!r.isError,
      ...(r.toolName === 'read_file' && r.output && typeof r.output === 'object' ? { path: (r.output as { path?: string }).path } : {}) }));
    const reads = sample.toolResults.filter((r: any) => r.name === 'read_file' && !r.failed).map((r: any) => r.path);
    sample.initialReadTurns = result.steps.filter(s => s.toolResults.some(r => r.toolName === 'read_file' && !r.isError)).slice(0, 4).map(s => s.toolResults.length);
    sample.initialReadOrder = JSON.stringify(reads.slice(0, 4)) === JSON.stringify(['src/01.txt', 'src/02.txt', 'src/03.txt', 'src/04.txt']);
    if (result.error) sample.failure = sanitizeOperationalError(result.error);
  } catch (error) {
    sample.failure = sanitizeOperationalError(error);
    sample.errorSummary = error instanceof Error ? error.message.split(process.env.OPENAI_API_KEY || '\0').join('[REDACTED]').slice(0, 800) : 'Unknown failure';
  } finally {
    if (started !== undefined) sample.taskMs ??= performance.now() - started;
    sample.calls = meter.snapshot(); sample.quality ??= { passed: false };
    if (sample.calls.length && sample.calls.every((c: any) => c.usage)) sample.usage = sample.calls.reduce((sum: any, call: any) => {
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens']) sum[key] = (sum[key] ?? 0) + call.usage[key];
      return sum;
    }, {});
    sample.usageMatches = !!sample.usage && sample.usage.totalTokens === sample.sdkUsage?.totalTokens;
    globalThis.fetch = nativeFetch;
    try { await harness?.close(); } catch (error) { sample.cleanupFailure = sanitizeOperationalError(error); }
    await writeFile(output, JSON.stringify(sample, null, 2) + '\n');
    await rm(root, { recursive: true, force: true });
  }
}
async function campaign() {
  assert(process.argv.includes('--live') && process.env.OPENAI_API_KEY, 'Explicit live opt-in and credentials required');
  const directory = path.resolve(arg('--directory')), runtimes = path.resolve(arg('--runtimes'));
  await mkdir(directory);
  const plan = models.flatMap(model => fixtures.flatMap(name => (stateless ? [0] : [0, 1]).map(repetition => ({ model, fixture: name, repetition,
    order: (stateless ? fixtures.indexOf(name) : repetition) % 2 ? ['after', 'before'] : ['before', 'after'] }))));
  const report: Record<string, any> = { schemaVersion: 1, startedAt: new Date().toISOString(), stateless, tokenBudget: stateless ? 300000 : 800000,
    reservePerPair: 120000, maxTaskTokens: 60000, maxRequests: 8, maxOutputPerRequest: 2048, reasoningEffort: 'low',
    plan, methodology: 'Default mode: eight pairs, two fixtures and two repetitions per model, alternating AB/BA. Stateless follow-up: four pairs, one repetition per model/fixture, alternating order across fixtures. Full live agent tool flow. Fresh cache routing keys on every request; reported cached tokens retained. No retries or favorable-sample selection. Quality requires six exact fields and correct initial file order. Failed tasks remain in totals. Baseline uses pre-optimization modules within the same migrated workspace.',
    artifacts: { runtimeManifest: JSON.parse(await readFile(path.join(runtimes, 'manifest.json'), 'utf8')), driver: hash(await readFile(process.argv[1]!)) },
    records: [], reportedTokens: 0, stopReason: 'running' };
  const save = () => writeFile(path.join(directory, 'campaign.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  outer: for (let i = 0; i < plan.length; i++) {
    if (report.reportedTokens + report.reservePerPair > report.tokenBudget) { report.stopReason = 'token-reserve'; break; }
    for (const variant of plan[i]!.order) {
      const item = plan[i]!, output = path.join(directory, `pair-${i + 1}-${variant}.json`);
      const child = Bun.spawn([process.execPath, process.argv[1]!, '--worker', '--runtime', path.join(runtimes, `${variant}.mjs`), '--model', item.model,
        '--fixture', item.fixture, '--repetition', String(item.repetition), '--variant', variant, '--output', output, ...(stateless ? ['--stateless'] : [])], { env: process.env, stdout: 'ignore', stderr: 'ignore' });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 195_000);
      const exit = await child.exited; clearTimeout(timeout);
      let sample: Record<string, any>;
      try { sample = JSON.parse(await readFile(output, 'utf8')); }
      catch { sample = { model: item.model, variant, fixture: item.fixture, repetition: item.repetition, completed: false, failure: 'WORKER_NO_REPORT', exit, calls: [] }; }
      report.records.push({ pair: i + 1, sample });
      report.reportedTokens += sample.calls.reduce((sum: number, c: any) => sum + (c.usage?.totalTokens ?? 0), 0);
      await save();
      console.log(JSON.stringify({ pair: i + 1, model: item.model, variant, status: sample.status ?? 'failed', quality: sample.quality?.passed ?? false, calls: sample.calls.length, tokens: sample.usage?.totalTokens, taskMs: sample.taskMs, reportedTokens: report.reportedTokens }));
      if (!sample.calls.length || sample.calls.some((c: any) => !c.usage)) { report.stopReason = 'unknown-usage'; break outer; }
      if (report.reportedTokens > report.tokenBudget || sample.usage.totalTokens > report.maxTaskTokens) { report.stopReason = 'token-budget'; break outer; }
      if (exit !== 0) { report.stopReason = 'worker-failure'; break outer; }
    }
  }
  if (report.stopReason === 'running') report.stopReason = 'planned-completion';
  report.finishedAt = new Date().toISOString(); await save();
}
if (import.meta.main) await (process.argv.includes('--worker') ? worker() : campaign());
