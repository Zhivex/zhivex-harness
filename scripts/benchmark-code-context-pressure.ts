import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContextLiveMeter } from './benchmarks/context-live/meter.js';
import { fixture, tasks as fixtures } from './benchmarks/code-context/fixtures.js';
import { grade } from './benchmarks/code-context/grade.js';
import { sanitizeOperationalError } from './release-diagnostics.js';
const arg = (name: string) => { const at = process.argv.indexOf(name); assert(at > 0 && process.argv[at + 1], `Missing ${name}`); return process.argv[at + 1]!; };
const models = ['gpt-6-luna', 'gpt-6.1-sol'];
// Both bundles use the production full-history wrapper; no caller store override.
const stateless = true;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function worker() {
  const model = arg('--model'), variant = arg('--variant'), output = arg('--output'), runtimePath = path.resolve(arg('--runtime'));
  assert(models.includes(model)); assert(['before', 'after'].includes(variant));
  const name = arg('--fixture') as typeof fixtures[number]; assert(fixtures.includes(name));
  const repetition = Number(arg('--repetition')); const data = await fixture(name, repetition as 4 | 6);
  const runtime = await import(pathToFileURL(runtimePath).href) as typeof import('../packages/core/src/runtime/harness.js');
  const root = await mkdtemp('/tmp/context-live-task-');
  const sample: Record<string, any> = { model, variant, fixture: name, repetition, fixtureHash: data.hash, bun: Bun.version, runtimeHash: hash(await readFile(runtimePath)), stateless, contextProfile: data.context, provenance: data.provenance, completed: false };
  const nativeFetch = globalThis.fetch;
  const meter = createContextLiveMeter(nativeFetch, model, 'low', () => performance.now(), 4096, true, 8, undefined, stateless);
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined, started: number | undefined;
  try {
    for (const [file, contents] of Object.entries(data.files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), contents); }
    globalThis.fetch = meter.fetch;
    harness = await runtime.createHarness({ workspace: root, provider: 'openai', model, env: process.env,
      reasoningEffort: 'low', toolNames: ['read_file', 'read_tool_result', 'discover_tools'], subagentProfiles: [], maxSteps: 8,
      unlimitedTokens: false, maxInputTokens: 300000, maxOutputTokens: 16000, maxTotalTokens: 316000,
      compactionMaxEstimatedInputTokens: 12000 });
    meter.start(); started = performance.now();
    const result = await runtime.runHarnessTask(harness, { prompt: data.prompt, maxSteps: 8, maxTokens: 4096, maxRetries: 0,
      providerOptions: { apiMode: 'responses',  }, abortSignal: AbortSignal.timeout(180_000) }, {
      onTaskTelemetry: telemetry => { sample.telemetry = telemetry; }
    });
    sample.taskMs = performance.now() - started;
    sample.status = result.status; sample.completed = result.status === 'completed'; sample.answer = result.outputText;
    sample.quality = await grade(data, result.outputText);
    sample.verifiedTaskMs = performance.now() - started; sample.sdkUsage = result.usage;
    sample.compactions = result.state.compactions?.length ?? 0;
    // Retain attempted paths as well as successful outputs for future security audits.
    // Earlier immutable campaigns did not capture failed read arguments.
    sample.toolCalls = result.steps.flatMap(step => step.response?.messages ?? []).flatMap(message => message.parts).flatMap(part => part.type === 'tool-call' ? [part.toolCall] : []).map(call => ({ name: call.name,
      ...(call.input && typeof call.input === 'object' && 'path' in call.input && typeof call.input.path === 'string' ? { attemptedPath: call.input.path.slice(0, 2000) } : {}) }));
    sample.toolResults = result.toolResults.map(r => ({ name: r.toolName, failed: !!r.isError,
      ...(r.toolName === 'read_file' && r.output && typeof r.output === 'object' ? { path: (r.output as { path?: string }).path, truncated: (r.output as any).truncated, characters: (r.output as any).content?.length } : {}) }));
    const reads = sample.toolResults.filter((r: any) => r.name === 'read_file' && !r.failed).map((r: any) => r.path);
    sample.initialReadTurns = result.steps.filter(s => s.toolResults.some(r => r.toolName === 'read_file' && !r.isError)).slice(0, repetition).map(s => s.toolResults.length);
    sample.initialReadOrder = JSON.stringify(reads.slice(0, repetition)) === JSON.stringify(data.paths);
    sample.security = { passed: sample.toolResults.every((r:any) => ['read_file','read_tool_result','discover_tools'].includes(r.name) && (r.name!=='read_file'||data.paths.includes(r.path))) && !result.outputText.includes('PRIVATE_BENCHMARK_CANARY'), unchanged: true };
    for (const [file,contents] of Object.entries(data.files)) if(await readFile(path.join(root,file),'utf8')!==contents) sample.security.unchanged=false;
    sample.security.passed &&= sample.security.unchanged;
    sample.contextComplete = sample.toolResults.filter((r:any)=>r.name==='read_file'&&!r.failed).every((r:any)=>r.truncated===false);
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
  const plan = models.flatMap(model => fixtures.flatMap(name => [6].map(repetition => ({ model, fixture: name, repetition,
    order: (fixtures.indexOf(name) % 2) ? ['after', 'before'] : ['before', 'after'] }))));
  const report: Record<string, any> = { schemaVersion: 1, startedAt: new Date().toISOString(), stateless, tokenBudget: 1200000,
    reservePerPair: 632000, maxTaskTokens: 316000, maxRequests: 8, maxOutputPerRequest: 4096, reasoningEffort: 'low',
    plan, methodology: 'Four prespecified pressure A/B pairs: two real repository security repairs, six full bounded files, two models. Source excerpts without repetitive padding. Expression-only patch proposals applied and tested by an isolated Bun grader. Both arms share full-history transport. Identical finite 300k/16k/316k token budgets and 12k compaction threshold. Low reasoning, 4096 output/request, 8 calls, no retries. Failures retained.',
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
