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
import { hardFixtures, gradeHardAnswer } from "./benchmarks/hard-preload-fixtures.js";
import { outputSchema, validateOutputSchema } from "./benchmarks/preload-output-schema.js";
import type { TaskTelemetrySnapshot } from "../src/runtime/task-telemetry.js";

const required = (name: string) => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], `Missing ${name}`); return process.argv[at + 1]!; };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface SchemaEffortSample {
  outputValidation?: ReturnType<typeof validateOutputSchema>;
  variant: "default" | "low"; fixture: string; runtime: string; calls: MeasuredCall[];
  runOffsetMs?: number; preloadMs?: number; preloadBytes?: number; preloadPaths?: string[]; status?: string; taskMs?: number; activityMs?: number; events?: number; answer?: string;
  quality?: ReturnType<typeof gradeHardAnswer>; correctReads?: boolean; completed?: boolean;
  telemetry?: TaskTelemetrySnapshot; sdkUsage?: { totalTokens?: number }; failure?: unknown;
}
async function worker() {
  const variant = required("--variant") as "default" | "low"; assert(["default", "low"].includes(variant));
  const fixture = hardFixtures.find(f => f.id === required("--fixture"))!; assert(fixture);
  const output = required("--output");
  const runtime = await import(pathToFileURL(path.resolve(required("--runtime"))).href) as
    Pick<typeof import("../src/runtime/harness.js"), "createHarness" | "runHarnessTask"> &
    Pick<typeof import("../src/client/service-events.js"), "openHarnessActivityStore">;
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-preload-"));
  const sample: SchemaEffortSample = { variant, fixture: fixture.id, runtime: process.version, calls: [] };
  const assigned = outputSchema(fixture.id);
  const nativeFetch = globalThis.fetch, meter = createOpenAICallMeter(nativeFetch, variant, () => performance.now(), 4096, true, 1,
    { mode: "json_schema", schemaHash: assigned.hash });
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined;
  let store: Awaited<ReturnType<typeof runtime.openHarnessActivityStore>> | undefined;
  let started: number | undefined, activityMs = 0, events = 0, answer = "";
  try {
    for (const [file, contents] of Object.entries(fixture.files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), contents); }
    globalThis.fetch = meter.fetch;
    harness = await runtime.createHarness({ workspace: root, provider: "openai", model: "gpt-6-luna", env: process.env,
      reasoningEffort: variant, toolNames: ["read_files"], subagentProfiles: [], maxSteps: 1,
      unlimitedTokens: false, maxInputTokens: 8192, maxOutputTokens: 8192, maxTotalTokens: 16384 });
    store = await runtime.openHarnessActivityStore(harness.config);
    for (let r = 0; r < 40; r++) store.append("s", `history-${r}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
    meter.start(); started = performance.now();
    sample.runOffsetMs = performance.now() - started;
    const result = await runtime.runHarnessTask(harness, {
      prompt: `Use the host-preloaded repository to repair ${fixture.name} against every contract rule. Return JSON with exactly replacement (standalone JavaScript function declaration named ${fixture.name}, no export/import), explanation (120-160 words explaining the fixes), and regressions (exactly three distinct regression tests, each {name,args,expected}; args is the function argument array; each test must fail the original implementation and pass your replacement). Handle all contract edge cases and preserve all inputs. Return replacement as a single-line JavaScript function (no newline escape sequences). Return only the JSON object, without markdown fences or additional keys. Do not edit files. ${assigned.instructions}`,
      maxSteps: 1, maxTokens: 4096, toolChoice: "none", providerOptions: { apiMode: "responses", text: { format: { type: "json_schema", name: "repository_repair", strict: true, schema: assigned.jsonSchema } } }, abortSignal: AbortSignal.timeout(60_000)
    }, { preloadFiles: { files: fixture.paths.map(path => ({ path })), maxBytes: 16000 }, onTaskTelemetry: value => { sample.telemetry = value; }, onEvent: event => {
      if (event.type === "text-delta") answer += event.textDelta;
      const begin = performance.now(); store!.append("s", "current", event); activityMs += performance.now() - begin; events++;
    } });
    sample.taskMs = performance.now() - started;
    const receipt = result.state.metadata?.zhivexKnownFilePreload as { requests?: { path: string }[]; bytes?: number } | undefined;
    if (receipt?.requests) sample.preloadPaths = receipt.requests.map(f => f.path).sort();
    if (receipt?.bytes !== undefined) sample.preloadBytes = receipt.bytes;
    sample.status = result.status; if (result.usage) sample.sdkUsage = result.usage;
    sample.correctReads = result.toolResults.length === 0 && JSON.stringify(sample.preloadPaths) === JSON.stringify([...fixture.paths].sort());
    sample.quality = gradeHardAnswer(fixture.id, answer);
    sample.outputValidation = validateOutputSchema(fixture.id, answer);
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
  const plan = hardFixtures.flatMap((fixture, fixtureIndex) => Array.from({ length: 4 }, (_, index) => ({ fixture: fixture.id,
    order: (index + fixtureIndex) % 2 === 0 ? ["default", "low"] as const : ["low", "default"] as const })));
  const rng = random(20261120);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [plan[i], plan[j]] = [plan[j]!, plan[i]!]; }
  const report = { schemaVersion: 1, model: "gpt-6-luna", plan, tokenBudget: 100_000, reservePerPair: 32768,
    maxTaskTokens: 16384, responseCap: 4096, maxRequests: 1, historicalRuns: 40,
    primary: "Eight fixed paired tasks, four per hard fixture, order balanced within fixture. Both use preload, one request, identical prompt/native strict JSON Schema and 4096 cap; only reasoning effort differs (default omitted versus explicit low). Primary: truncation and full executable quality; secondary schema validity, parseability, provider completion, wall latency and tokens. Exact paired discordance tests; stratified paired bootstrap for continuous metrics. No exclusions by quality, retries or repairs. Unique cache key per call; stop on nonzero/unknown cached usage. 100000-token budget, 32768 reservation per pair.",
    qualityCriteria: "Same strict output schema evaluated in BOTH arms, 11 functional/nonmutation cases, three regression examples failing original code, 120-160 words. Provider completion alone is insufficient.",
    startedAt: new Date().toISOString(), artifacts: { runtime: hash(await readFile(runtime)), worker: hash(await readFile(process.argv[1]!)), fixtures: hash(JSON.stringify(hardFixtures)), schemas: hash(JSON.stringify(hardFixtures.map(f => outputSchema(f.id).jsonSchema))) },
    records: [] as Array<{ pair: number; position: number; sample: SchemaEffortSample }>, reportedTokens: 0, stopReason: "running" };
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
      let sample: SchemaEffortSample;
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
