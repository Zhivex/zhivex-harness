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
import { reasoningFixtures, gradeReasoningAnswer } from "./benchmarks/reasoning-fixtures.js";
import type { TaskTelemetrySnapshot } from "../src/runtime/task-telemetry.js";

const required = (name: string) => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], `Missing ${name}`); return process.argv[at + 1]!; };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface ReasoningSample {
  effort: "default" | "low"; fixture: string; runtime: string; calls: MeasuredCall[];
  status?: string; taskMs?: number; activityMs?: number; events?: number; answer?: string;
  quality?: ReturnType<typeof gradeReasoningAnswer>; correctReads?: boolean; completed?: boolean;
  telemetry?: TaskTelemetrySnapshot; sdkUsage?: { totalTokens?: number }; failure?: unknown;
}
async function worker() {
  const effort = required("--effort") as "default" | "low"; assert(["default", "low"].includes(effort));
  const fixture = reasoningFixtures.find(f => f.id === required("--fixture"))!; assert(fixture);
  const output = required("--output");
  const runtime = await import(pathToFileURL(path.resolve(required("--runtime"))).href) as
    Pick<typeof import("../src/runtime/harness.js"), "createHarness" | "runHarnessTask"> &
    Pick<typeof import("../src/client/service-events.js"), "openHarnessActivityStore">;
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-reasoning-"));
  const sample: ReasoningSample = { effort, fixture: fixture.id, runtime: process.version, calls: [] };
  const nativeFetch = globalThis.fetch, meter = createOpenAICallMeter(nativeFetch, effort);
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined;
  let store: Awaited<ReturnType<typeof runtime.openHarnessActivityStore>> | undefined;
  let started: number | undefined, activityMs = 0, events = 0, answer = "";
  try {
    for (const [file, contents] of Object.entries(fixture.files)) await writeFile(path.join(root, file), contents);
    globalThis.fetch = meter.fetch;
    harness = await runtime.createHarness({ workspace: root, provider: "openai", model: "gpt-6-luna", env: process.env,
      reasoningEffort: effort, toolNames: ["read_files"], subagentProfiles: [], maxSteps: 3,
      unlimitedTokens: false, maxInputTokens: 4096, maxOutputTokens: 2048, maxTotalTokens: 6144 });
    store = await runtime.openHarnessActivityStore(harness.config);
    for (let r = 0; r < 40; r++) store.append("s", `history-${r}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
    meter.start(); started = performance.now();
    const result = await runtime.runHarnessTask(harness, {
      prompt: `Read a.txt and b.txt using read_files in one call. ${fixture.task} The explanation must be 80 to 100 words, grounded only in the files. Return only the JSON object, without markdown fences or additional keys. Do not edit files.`,
      maxSteps: 3, maxTokens: 1024, providerOptions: { apiMode: "responses" }, abortSignal: AbortSignal.timeout(60_000)
    }, { onTaskTelemetry: value => { sample.telemetry = value; }, onEvent: event => {
      if (event.type === "text-delta") answer += event.textDelta;
      const begin = performance.now(); store!.append("s", "current", event); activityMs += performance.now() - begin; events++;
    } });
    sample.taskMs = performance.now() - started;
    sample.status = result.status; if (result.usage) sample.sdkUsage = result.usage;
    const reads = result.toolResults.filter(r => r.toolName === "read_files" && !r.isError);
    sample.correctReads = reads.length === 1 && JSON.stringify(((reads[0]!.output as { files?: { path: string }[] })?.files ?? []).map(f => f.path).sort()) === JSON.stringify(["a.txt", "b.txt"]);
    sample.quality = gradeReasoningAnswer(fixture.id, answer);
    sample.completed = result.status === "completed";
    if (result.error) sample.failure = sanitizeOperationalError(result.error);
  } catch (error) { sample.failure = sanitizeOperationalError(error); sample.completed = false; }
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
  const plan = reasoningFixtures.flatMap(fixture => Array.from({ length: 6 }, (_, index) => ({ fixture: fixture.id,
    order: index % 2 === 0 ? ["default", "low"] as const : ["low", "default"] as const })));
  const rng = random(20261114);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [plan[i], plan[j]] = [plan[j]!, plan[i]!]; }
  const report = { schemaVersion: 1, model: "gpt-6-luna", plan, tokenBudget: 90_000, reservePerPair: 12288,
    maxTaskTokens: 6144, maxResponseTokens: 1024, maxRequests: 3, historicalRuns: 40,
    primary: "Fixed 18 paired tasks, balanced per fixture; all completed pairs enter latency regardless of quality; stratified paired mean bootstrap CI. Quality scored independently. No significance stopping or retries.",
    qualityCriteria: "Exact fixture answers, exact JSON keys, 80-100-word explanation, successful read of both files; synthetic prose retained for review.",
    startedAt: new Date().toISOString(), artifacts: { runtime: hash(await readFile(runtime)), worker: hash(await readFile(process.argv[1]!)), fixtures: hash(JSON.stringify(reasoningFixtures)) },
    records: [] as Array<{ pair: number; position: number; sample: ReasoningSample }>, reportedTokens: 0, stopReason: "running" };
  const save = () => writeFile(path.join(directory, "campaign.json"), JSON.stringify(report, null, 2) + "\n");
  await save(); let transportFailures = 0;
  outer: for (let i = 0; i < plan.length; i++) {
    if (report.reportedTokens + report.reservePerPair > report.tokenBudget) { report.stopReason = "token-reserve"; break; }
    for (let position = 0; position < 2; position++) {
      const effort = plan[i]!.order[position]!, output = path.join(directory, `pair-${i + 1}-${effort}.json`);
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("node", [process.argv[1]!, "--worker", "--runtime", runtime, "--fixture", plan[i]!.fixture, "--effort", effort, "--output", output], { env: process.env, stdio: "ignore" });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 75_000);
        child.once("error", e => { clearTimeout(timeout); reject(e); });
        child.once("exit", code => { clearTimeout(timeout); resolve(code); });
      });
      let sample: ReasoningSample;
      try { sample = JSON.parse(await readFile(output, "utf8")); }
      catch { sample = { effort, fixture: plan[i]!.fixture, runtime: "unknown", calls: [], completed: false, failure: { code: "WORKER_NO_REPORT", exit } }; }
      report.records.push({ pair: i + 1, position, sample });
      const tokens = sample.calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0);
      report.reportedTokens += tokens; await save();
      if (!sample.calls.length || sample.calls.some(call => !call.usage)) { report.stopReason = "unknown-usage"; break outer; }
      if (tokens > 6144 || report.reportedTokens > report.tokenBudget) { report.stopReason = "token-budget"; break outer; }
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
