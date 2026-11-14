import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { random } from "./benchmarks/paired-statistics.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";
import { createOpenAICallMeter, type MeasuredCall } from "./benchmarks/openai-call-meter.js";
import { repositoryFixtures, gradeRepositoryAnswer } from "./benchmarks/repository-preload-fixtures.js";
import type { TaskTelemetrySnapshot } from "../src/runtime/task-telemetry.js";

const required = (name: string) => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], `Missing ${name}`); return process.argv[at + 1]!; };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface ColdPreloadSample {
  variant: "tool" | "preload"; fixture: string; runtime: string; calls: MeasuredCall[];
  runOffsetMs?: number; preloadMs?: number; preloadBytes?: number; preloadPaths?: string[]; status?: string; taskMs?: number; activityMs?: number; events?: number; answer?: string;
  quality?: ReturnType<typeof gradeRepositoryAnswer>; correctReads?: boolean; completed?: boolean;
  telemetry?: TaskTelemetrySnapshot; sdkUsage?: { totalTokens?: number }; failure?: unknown;
}
async function worker() {
  const variant = required("--variant") as "tool" | "preload"; assert(["tool", "preload"].includes(variant));
  const fixture = repositoryFixtures.find(f => f.id === required("--fixture"))!; assert(fixture);
  const output = required("--output");
  const runtime = await import(pathToFileURL(path.resolve(required("--runtime"))).href) as
    Pick<typeof import("../src/runtime/harness.js"), "createHarness" | "runHarnessTask"> &
    Pick<typeof import("../src/client/service-events.js"), "openHarnessActivityStore">;
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-preload-"));
  const sample: ColdPreloadSample = { variant, fixture: fixture.id, runtime: process.version, calls: [] };
  const nativeFetch = globalThis.fetch, meter = createOpenAICallMeter(nativeFetch, "default", () => performance.now(), 4096, true);
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined;
  let store: Awaited<ReturnType<typeof runtime.openHarnessActivityStore>> | undefined;
  let started: number | undefined, activityMs = 0, events = 0, answer = "";
  try {
    for (const [file, contents] of Object.entries(fixture.files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), contents); }
    globalThis.fetch = meter.fetch;
    harness = await runtime.createHarness({ workspace: root, provider: "openai", model: "gpt-6-luna", env: process.env,
      reasoningEffort: "default", toolNames: ["read_files"], subagentProfiles: [], maxSteps: 3,
      unlimitedTokens: false, maxInputTokens: 8192, maxOutputTokens: 8192, maxTotalTokens: 16384 });
    store = await runtime.openHarnessActivityStore(harness.config);
    for (let r = 0; r < 40; r++) store.append("s", `history-${r}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
    meter.start(); started = performance.now();
    const prefix = variant === "tool" ? `Read these files together using read_files: ${fixture.paths.join(", ")}.` : "Use the host-preloaded file snapshots to solve the task.";
    sample.runOffsetMs = performance.now() - started;
    const result = await runtime.runHarnessTask(harness, {
      prompt: `${prefix} ${fixture.task} The explanation must be 80 to 100 words, grounded only in the files. Return replacement as a single-line JavaScript function (no newline escape sequences). Return only the JSON object, without markdown fences or additional keys. Do not edit files.`,
      maxSteps: 3, maxTokens: 4096, providerOptions: { apiMode: "responses" }, abortSignal: AbortSignal.timeout(60_000)
    }, { ...(variant === "preload" ? { preloadFiles: { files: fixture.paths.map(path => ({ path })), maxBytes: 16000 } } : {}), onTaskTelemetry: value => { sample.telemetry = value; }, onEvent: event => {
      if (event.type === "text-delta") answer += event.textDelta;
      const begin = performance.now(); store!.append("s", "current", event); activityMs += performance.now() - begin; events++;
    } });
    sample.taskMs = performance.now() - started;
    const receipt = result.state.metadata?.zhivexKnownFilePreload as { requests?: { path: string }[]; bytes?: number } | undefined;
    if (receipt?.requests) sample.preloadPaths = receipt.requests.map(f => f.path).sort();
    if (receipt?.bytes !== undefined) sample.preloadBytes = receipt.bytes;
    sample.status = result.status; if (result.usage) sample.sdkUsage = result.usage;
    const reads = result.toolResults.filter(r => r.toolName === "read_files" && !r.isError);
    sample.correctReads = variant === "preload" ? result.toolResults.length === 0 && JSON.stringify(sample.preloadPaths) === JSON.stringify([...fixture.paths].sort()) : reads.length === 1 && JSON.stringify(((reads[0]!.output as { files?: { path: string }[] })?.files ?? []).map(f => f.path).sort()) === JSON.stringify([...fixture.paths].sort());
    sample.quality = gradeRepositoryAnswer(fixture.id, answer);
    sample.completed = result.status === "completed";
    if (result.error) sample.failure = sanitizeOperationalError(result.error);
  } catch (error) { sample.failure = sanitizeOperationalError(error); sample.completed = false;
    const chain: string[] = []; let current: unknown = error;
    for (let i=0; i<4 && current instanceof Error; i++,current=current.cause) chain.push(current.message.split(process.env.OPENAI_API_KEY || "\0").join("[REDACTED]").slice(0,500));
    await writeFile(output + ".diagnostic.json", JSON.stringify(chain)); }
  finally {
    if (started !== undefined) sample.taskMs ??= performance.now() - started;
    sample.activityMs = activityMs; sample.events = events; sample.calls = meter.snapshot();
    // Only synthetic fixture output is retained for a separate quality review.
    sample.answer = answer.split(process.env.OPENAI_API_KEY || "\0").join("[REDACTED]").slice(0, 32_768);
    globalThis.fetch = nativeFetch;
    try { store?.close(); await harness?.close(); }
    catch (error) { sample.failure = sanitizeOperationalError(error); sample.completed = false; }
    await writeFile(output, JSON.stringify(sample, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
async function campaign() {
  assert(process.argv.includes("--live") && process.env.OPENAI_API_KEY, "Explicit live opt-in and credentials required");
  const directory = path.resolve(required("--directory")), runtime = path.resolve(required("--runtime"));
  await mkdir(directory);
  const plan = repositoryFixtures.flatMap((fixture, fixtureIndex) => Array.from({ length: 4 }, (_, index) => ({ fixture: fixture.id,
    order: (index + fixtureIndex) % 2 === 0 ? ["tool", "preload"] as const : ["preload", "tool"] as const })));
  const rng = random(20261117);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [plan[i], plan[j]] = [plan[j]!, plan[i]!]; }
  const report = { schemaVersion: 1, model: "gpt-6-luna", plan, tokenBudget: 90_000, reservePerPair: 32768,
    maxTaskTokens: 16384, maxResponseTokens: 4096, maxRequests: 3, historicalRuns: 40,
    primary: "Fixed 8 paired repository tasks, balanced per fixture; all completed pairs enter latency regardless of quality; stratified paired mean bootstrap CI. Quality scored independently. Total time includes preload. Both variants use default reasoning and identical available tools. No significance stopping or retries. 4096 response cap, 90000-token campaign limit. Unique cache key per request; stop on nonzero or missing cached usage.",
    qualityCriteria: "Replacement passes executable contract cases without input mutation, JSON format, 80-100 words, all selected files read; failures retained.",
    startedAt: new Date().toISOString(), artifacts: { runtime: hash(await readFile(runtime)), worker: hash(await readFile(process.argv[1]!)), fixtures: hash(JSON.stringify(repositoryFixtures)) },
    records: [] as Array<{ pair: number; position: number; sample: ColdPreloadSample }>, reportedTokens: 0, stopReason: "running" };
  const save = () => writeFile(path.join(directory, "campaign.json"), JSON.stringify(report, null, 2) + "\n");
  await save(); let transportFailures = 0;
  outer: for (let i = 0; i < plan.length; i++) {
    if (report.reportedTokens + report.reservePerPair > report.tokenBudget) { report.stopReason = "token-reserve"; break; }
    for (let position = 0; position < 2; position++) {
      const variant = plan[i]!.order[position]!, output = path.join(directory, `pair-${i + 1}-${variant}.json`);
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("node", [process.argv[1]!, "--worker", "--runtime", runtime, "--fixture", plan[i]!.fixture, "--variant", variant, "--output", output], { env: process.env, stdio: "ignore" });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 75_000);
        child.once("error", e => { clearTimeout(timeout); reject(e); });
        child.once("exit", code => { clearTimeout(timeout); resolve(code); });
      });
      let sample: ColdPreloadSample;
      try { sample = JSON.parse(await readFile(output, "utf8")); }
      catch { sample = { variant, fixture: plan[i]!.fixture, runtime: "unknown", calls: [], completed: false, failure: { code: "WORKER_NO_REPORT", exit } }; }
      if (exit !== 0) { sample.failure = { code: "WORKER_EXIT", exit, original: sample.failure }; sample.completed = false; }
      report.records.push({ pair: i + 1, position, sample });
      const tokens = sample.calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0);
      report.reportedTokens += tokens; await save();
      if (!sample.calls.length || sample.calls.some(call => !call.usage)) { report.stopReason = "unknown-usage"; break outer; }
      if (tokens > 16384 || report.reportedTokens > report.tokenBudget) { report.stopReason = "token-budget"; break outer; }
      if (sample.calls.some(call => !call.cachedUsageReported || call.usage!.cachedInputTokens !== 0)) { report.stopReason = "cache-control-failed"; break outer; }
      transportFailures = sample.completed ? 0 : transportFailures + 1;
      if (transportFailures >= 2) { report.stopReason = "consecutive-failures"; break outer; }
    }
    console.log(JSON.stringify({ pairs: i + 1, tasks: report.records.length, reportedTokens: report.reportedTokens }));
  }
  if (report.stopReason === "running") report.stopReason = "planned-completion";
  await save();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (process.argv.includes("--worker") ? worker() : campaign()).catch(error => { console.error(JSON.stringify(sanitizeOperationalError(error))); process.exitCode = 1; });
}
