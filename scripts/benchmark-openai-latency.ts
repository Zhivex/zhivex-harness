import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TaskTelemetrySnapshot } from "../src/runtime/task-telemetry.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const required = (name: string) => { assert(process.argv.includes(name) && arg(name), `Missing ${name}`); return arg(name)!; };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
import { random } from "./benchmarks/paired-statistics.js";
export { mean, median, random, pairedSummary } from "./benchmarks/paired-statistics.js";

interface Sample {
  status?: string; valid?: boolean; taskMs?: number; activityMs?: number; events?: number; requests?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
  telemetry?: TaskTelemetrySnapshot; failure?: unknown; runtime?: string;
  responseLimits?: number[]; toolCalls?: { name: string; failed: boolean }[];
  outputWords?: number;
  transportUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; reasoningTokens: number };
  transportHeadersMs?: number;
  checkpoint?: string;
  meteredResponses?: number;
  incompleteResponses?: number;
}
async function worker() {
  const output = required("--output"), model = required("--model");
  const runtime = await import(pathToFileURL(path.resolve(required("--runtime"))).href) as
    Pick<typeof import("../src/runtime/harness.js"), "createHarness" | "runHarnessTask"> &
    Pick<typeof import("../src/client/service-events.js"), "openHarnessActivityStore">;
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-pair-"));
  const sample: Sample = { runtime: process.version, responseLimits: [] };
  let harness: Awaited<ReturnType<typeof runtime.createHarness>> | undefined;
  let store: Awaited<ReturnType<typeof runtime.openHarnessActivityStore>> | undefined;
  let requests = 0;
  const nativeFetch = globalThis.fetch;
  const transportUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let meteredResponses = 0, transportHeadersMs = 0, incompleteResponses = 0;
  const requestBodies = new Set<string>();
  try {
    await writeFile(path.join(root, "a.txt"), "ALPHA: apples\n");
    await writeFile(path.join(root, "b.txt"), "BETA: bananas\n");
    const guardedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      sample.checkpoint = "request-guard";
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.equal(new URL(url).hostname, "api.openai.com", "Only the official OpenAI endpoint is permitted");
      assert.equal(typeof init?.body, "string", "Expected bounded JSON request");
      const body = init!.body as string, fingerprint = digest(body);
      assert(!requestBodies.has(fingerprint), "Transport retry refused");
      assert(requests < 3 && Buffer.byteLength(body) <= 32_768, "Request budget exhausted");
      const payload = JSON.parse(body) as { max_output_tokens?: number };
      assert(Number.isInteger(payload.max_output_tokens) && payload.max_output_tokens! > 0 && payload.max_output_tokens! <= 1024, "Missing response token cap");
      sample.responseLimits!.push(payload.max_output_tokens!);
      requestBodies.add(fingerprint); requests++;
      const started = performance.now();
      const response = await nativeFetch(input, init);
      transportHeadersMs += performance.now() - started;
      sample.checkpoint = "response-stream";
      if (!response.body) return response;
      let pending = "";
      const decoder = new TextDecoder();
      const bodyStream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!;
        assert(pending.length < 128 * 1024, "Unbounded SSE line");
        for (const line of lines) {
          if (!line.startsWith("data:") || !/response\.(completed|incomplete|failed)/.test(line)) continue;
          const event = JSON.parse(line.slice(5));
          if (!["response.completed", "response.incomplete", "response.failed"].includes(event.type)) continue;
          if (event.type !== "response.completed") incompleteResponses++;
          const usage = event.response?.usage;
          if (Number.isSafeInteger(usage?.total_tokens)) {
            meteredResponses++;
            transportUsage.inputTokens += usage.input_tokens ?? 0;
            transportUsage.outputTokens += usage.output_tokens ?? 0;
            transportUsage.totalTokens += usage.total_tokens;
            transportUsage.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? 0;
            transportUsage.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
          }
        }
        controller.enqueue(chunk);
      } }));
      return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as typeof fetch;
    globalThis.fetch = guardedFetch;
    sample.checkpoint = "harness-create";
    harness = await runtime.createHarness({ workspace: root, provider: "openai", model, env: process.env,
      toolNames: ["read_files"], subagentProfiles: [], maxSteps: 3,
      unlimitedTokens: false, maxInputTokens: 4096, maxOutputTokens: 2048, maxTotalTokens: 6144 });
    store = await runtime.openHarnessActivityStore(harness.config);
    for (let r = 0; r < 40; r++) store.append("s", `history-${r}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
    let activityMs = 0, events = 0, outputText = "";
    const start = performance.now();
    sample.checkpoint = "task";
    const result = await runtime.runHarnessTask(harness, {
      prompt: "Read a.txt and b.txt using read_files in one call. Then explain their contents in 80 to 100 words. Do not edit files.",
      maxSteps: 3, maxTokens: 1024, providerOptions: { apiMode: "responses" }, abortSignal: AbortSignal.timeout(60_000)
    }, { onTaskTelemetry: value => { sample.telemetry = value; }, onEvent: event => {
      if (event.type === "text-delta") outputText += event.textDelta;
      const begin = performance.now(); store!.append("s", "current", event); activityMs += performance.now() - begin; events++;
    } });
    sample.taskMs = performance.now() - start;
    sample.checkpoint = "collected";
    Object.assign(sample, { status: result.status, activityMs, events, usage: result.usage,
      toolCalls: result.toolResults.map(r => ({ name: r.toolName, failed: !!r.isError })) });
    sample.outputWords = outputText.trim().split(/\s+/).filter(Boolean).length;
    sample.valid = result.status === "completed" && sample.outputWords >= 60 && incompleteResponses === 0 && result.toolResults.some(r => r.toolName === "read_files" && !r.isError);
    if (result.error) sample.failure = sanitizeOperationalError(result.error);
  } catch (error) { sample.failure = sanitizeOperationalError(error); sample.valid = false; }
  finally {
    sample.requests = requests;
    sample.meteredResponses = meteredResponses;
    sample.incompleteResponses = incompleteResponses;
    sample.transportHeadersMs = transportHeadersMs;
    if (meteredResponses > 0) sample.transportUsage = transportUsage;
    globalThis.fetch = nativeFetch;
    try { store?.close(); await harness?.close(); }
    catch (error) { sample.failure = sanitizeOperationalError(error); sample.valid = false; }
    await writeFile(output, JSON.stringify(sample, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}

async function campaign() {
  assert(process.argv.includes("--live"), "Real requests require --live");
  assert(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required");
  const directory = path.resolve(required("--directory"));
  const runtimes = { baseline: path.resolve(required("--baseline")), candidate: path.resolve(required("--candidate")) };
  const model = "gpt-6-luna", pairs = 20, tokenBudget = 95_000, reservePerPair = 12288;
  const reportFile = path.join(directory, "campaign.json");
  // Never overwrite an existing campaign or silently resume paid requests.
  await mkdir(directory);
  const rng = random(20261113);
  const order = Array.from({ length: pairs }, (_, i) => i % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const records: Array<{ pair: number; variant: keyof typeof runtimes; position: number; sample: Sample }> = [];
  const report = { schemaVersion: 1, model, pairs, tokenBudget, reservePerPair, maxRequestsPerTask: 3,
    maxResponseTokens: 1024, maxTaskTokens: 6144, historicalRuns: 40, runtime: "Node 22", seed: 20261113,
    primary: "Paired mean reduction in runHarnessTask wall time; 95% percentile paired bootstrap, 10000 resamples; fixed sample size, no significance stopping.",
    order, artifacts: { baseline: digest(await readFile(runtimes.baseline)), candidate: digest(await readFile(runtimes.candidate)), worker: digest(await readFile(process.argv[1]!)) },
    records, reportedTokens: 0, stopReason: "running", startedAt: new Date().toISOString() };
  const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  await save();
  let failures = 0;
  outer: for (let pair = 0; pair < pairs; pair++) {
    if (report.reportedTokens + reservePerPair > tokenBudget) { report.stopReason = "token-reserve"; break; }
    for (let position = 0; position < 2; position++) {
      const variant = order[pair]![position]!, output = path.join(directory, `pair-${pair + 1}-${variant}.json`);
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("node", [process.argv[1]!, "--worker", "--runtime", runtimes[variant], "--model", model, "--output", output],
          { env: process.env, stdio: "ignore" });
        const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      let sample: Sample;
      try { sample = JSON.parse(await readFile(output, "utf8")) as Sample; }
      catch { sample = { valid: false, failure: { code: "WORKER_NO_REPORT", exit } }; }
      records.push({ pair: pair + 1, variant, position, sample });
      const tokens = sample.transportUsage?.totalTokens ?? sample.usage?.totalTokens;
      if (Number.isSafeInteger(tokens) && tokens! >= 0) report.reportedTokens += tokens!;
      failures = sample.valid ? 0 : failures + 1;
      await save();
      if (!Number.isSafeInteger(tokens) || tokens! < 0 || sample.requests !== sample.meteredResponses) { report.stopReason = "unknown-usage"; break outer; }
      if (report.reportedTokens > tokenBudget || tokens! > 6144) { report.stopReason = "token-budget"; break outer; }
      if (failures >= 2) { report.stopReason = "consecutive-failures"; break outer; }
    }
    console.log(JSON.stringify({ pair: pair + 1, tasks: records.length, reportedTokens: report.reportedTokens }));
  }
  if (report.stopReason === "running") report.stopReason = "planned-completion";
  await save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (process.argv.includes("--worker") ? worker() : campaign()).catch(error => {
    console.error(JSON.stringify(sanitizeOperationalError(error))); process.exitCode = 1;
  });
}
