import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { openHarnessActivityStore } from "../src/client/service-events.js";
import { openCliSessionStore } from "../src/persistence/sessions.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";
import { Workspace } from "../src/workspace/workspace.js";
import { createContextRuntime } from "../src/runtime/context-runtime.js";
import { createHarness, runHarnessTask } from "../src/runtime/harness.js";
import type { TaskTelemetrySnapshot } from "../src/runtime/task-telemetry.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

// Fixtures are temporary, reports contain numeric diagnostics only. --live is
// explicit opt-in; three short read-only runs, no retry or external workspace.
const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, p50Ms: sorted[Math.ceil(sorted.length / 2) - 1], totalMs: samples.reduce((a, b) => a + b, 0) };
};
const measure = async (count: number, work: () => unknown | Promise<unknown>) => {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); await work(); samples.push(performance.now() - start); }
  return summarize(samples);
};
const root = await mkdtemp(path.join(os.tmpdir(), "harness-overhead-"));
const report: Record<string, unknown> = { schemaVersion: 1, runtime: process.version, bun: process.versions.bun,
  methodology: "Sequential local samples; setup excluded; warm filesystem; live calls are three independent read-only tasks, not a statistical latency claim." };
try {
  const config = resolveHarnessConfig({ workspace: root });
  const activity = await openHarnessActivityStore(config);
  try {
    const rows = [];
    for (let stage = 0; stage < 3; stage++) {
      if (stage) for (let i = 0; i < 40; i++) activity.append("s", `history-${stage}-${i}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
      rows.push({ historicalRuns: stage * 40, ...await measure(100, () => activity.append("s", "current", { type: "text-delta", textDelta: "small output chunk " })) });
    }
    report.activity = rows;
  } finally { activity.close(); }
  const sessions = await openCliSessionStore({ workspace: root, stateDirectory: config.stateDirectory, scope: config.scope });
  try {
    for (let i = 0; i < 200; i++) await sessions.create({ title: `session ${i}`, initialRun: { runId: `run-${i}`, provider: "openai", model: "fixture", status: "completed" } });
    report.sessions = await measure(30, async () => assert.equal((await sessions.list({ limit: 200 })).length, 200));
  } finally { sessions.close(); }
  for (let i = 0; i < 16; i++) {
    await mkdir(path.join(root, `group-${i}`));
    await writeFile(path.join(root, `group-${i}/AGENTS.md`), "Use clear names.\n");
    await writeFile(path.join(root, `group-${i}/a.txt`), `Fixture ${i}\n`);
  }
  const workspace = await Workspace.open(root);
  const context = await createContextRuntime(workspace, {}, true);
  const wrapped = context.wrapTools({ read_file: { execute: async (input: { path: string }) => ({ path: input.path }) } } as never);
  const read = wrapped.read_file!;
  assert("execute" in read && read.execute);
  for (let i = 0; i < 16; i++) await read.execute({ path: `group-${i}/a.txt` }, {} as never);
  report.context = await measure(50, () => read.execute!({ path: "group-0/a.txt" }, {} as never));
  const audited = await Workspace.open(root, { auditPath: path.join(root, "audit.json") });
  report.audit = await measure(5, () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({ path: `edit-${audited.mutationAudit().length}-${i}.txt`, expectedDigest: null, content: "fixture\n" }));
    return audited.applyPatch({ proposalId: createEditProposal({ changes }).proposalId, changes });
  });
  if (process.argv.includes("--live")) {
    assert(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required");
    const model = process.env.ZHIVEX_HARNESS_LIVE_OPENAI_MODEL || "gpt-6-luna";
    const live: Record<string, unknown>[] = [];
    report.live = live;
    for (let i = 0; i < 3; i++) {
      const liveRoot = path.join(root, `live-${i}`); await mkdir(liveRoot);
      await writeFile(path.join(liveRoot, "a.txt"), "ALPHA: apples\n");
      await writeFile(path.join(liveRoot, "b.txt"), "BETA: bananas\n");
      const harness = await createHarness({ workspace: liveRoot, provider: "openai", model, env: process.env,
        toolNames: ["read_files"], subagentProfiles: [], maxSteps: 3, maxOutputTokens: 1024 });
      const store = await openHarnessActivityStore(harness.config);
      try {
        for (let r = 0; r < 40; r++) store.append("s", `history-${r}`, { type: "text-delta", textDelta: "ordinary fixture text ".repeat(1000) });
        let telemetry: TaskTelemetrySnapshot | undefined;
        let activityMs = 0, events = 0;
        const result = await runHarnessTask(harness, {
          prompt: "Read a.txt and b.txt using read_files in one call. Then explain their contents in 80 to 100 words. Do not edit files.",
          maxSteps: 3, providerOptions: { apiMode: "responses" }, abortSignal: AbortSignal.timeout(90_000)
        }, { onTaskTelemetry: value => { telemetry = value; }, onEvent: event => {
          const start = performance.now(); store.append("s", "current", event); activityMs += performance.now() - start; events++;
        } });
        live.push({ status: result.status, model, activityMs, events, steps: result.steps.length,
          toolCalls: result.toolResults.map(r => ({ name: r.toolName, failed: !!r.isError })), usage: result.usage, telemetry });
        assert.equal(result.status, "completed");
        assert(result.toolResults.some(r => r.toolName === "read_files" && !r.isError));
      } finally { store.close(); await harness.close(); }
    }
  }
} catch (error) {
  // Keep partial samples and a sanitized failure instead of silently dropping
  // failed paid attempts from the report. Never dump a provider error object.
  report.failure = sanitizeOperationalError(error);
  process.exitCode = 1;
} finally {
  const output = process.argv.indexOf("--output");
  try {
    if (output >= 0) await writeFile(process.argv[output + 1]!, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
