import { expect, test } from "bun:test";
import type { AgentStreamEvent } from "@zhivex-ai/agents";
import type { TokenUsage } from "@zhivex-ai/core";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { emptyLimitSettings } from "../src/limit-settings.js";
import { WebLimitStore } from "../src/limit-store.js";
import { WebLimitMonitor } from "../src/limit-monitor.js";
import { createHarness, runHarness } from "@zhivex-ai/harness/engine";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { dirname } from "node:path";
const runId = "run_test";
const step = (index: number, usage: TokenUsage): AgentStreamEvent => ({ type: "agent-step-finish", step: {
  index, status: "completed", request: { messages: [] }, response: { messages: [], usage }, toolResults: [],
} });
async function fixture(job: (store: WebLimitStore) => Promise<void>) {
  const directory = await realpath(await mkdtemp("/tmp/web-limit-observer-"));
  try { await job(new WebLimitStore(directory, "atlas")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("immutable per-run snapshot warns once, persists usage and does not mutate active settings", async () => {
  await fixture(async store => {
    const settings = { ...emptyLimitSettings(), tokens: { value: 10, action: "notify" as const } };
    await store.save("project", settings, 0);
    let cancellations = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancellations++; }, { inputPerMillion: 1, outputPerMillion: 2, source: "fixture" });
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 1, maxSteps: 50 });
      await store.save("project", emptyLimitSettings(), 1);
      await monitor.event("session", runId, step(1, { inputTokens: 7, outputTokens: 4, totalTokens: 11 }));
      await monitor.event("session", runId, step(2, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }));
      const record = await store.readRun(runId);
      expect(record?.settings).toEqual(settings);
      expect(record?.notices).toHaveLength(1);
      expect(record?.consumption.tokens).toBe(13);
      expect(record?.consumption.costUsd).toBe(.000018);
      expect(cancellations).toBe(0);
    } finally { await monitor.close(); }
  });
});
test("stop uses existing cancellation once and preserves a durable reason; unknown cost stays unknown", async () => {
  await fixture(async store => {
    await store.save("task", { ...emptyLimitSettings(), tokens: { value: 1, action: "stop" } }, 0);
    let cancelled = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancelled++; }, null);
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 1, maxSteps: 50 });
      await monitor.event("other-session", runId, step(1, { totalTokens: 5 }));
      expect(cancelled).toBe(0);
      await monitor.event("session", runId, step(1, { totalTokens: 5 }));
      await monitor.event("session", runId, step(2, { totalTokens: 5 }));
      expect(cancelled).toBe(1);
      expect((await store.readRun(runId))?.cancellationRequested).toBe(true);
      expect((await store.readRun(runId))?.consumption.costUsd).toBeNull();
    } finally { await monitor.close(); }
  });
});
test("duration warning uses active execution time and excludes parked approvals", async () => {
  await fixture(async store => {
    let now = 0;
    await store.save("task", { ...emptyLimitSettings(), durationMinutes: { value: 1, action: "notify" } }, 0);
    const monitor = new WebLimitMonitor(store, async () => {}, null, () => now);
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 1, maxSteps: 50 });
      now = 30_000;
      await monitor.checkpoint("session", runId, "waiting_approval");
      now = 1_000_000;
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 2, maxSteps: 50 });
      now += 30_000;
      await monitor.event("session", runId, step(1, {}));
      expect((await store.readRun(runId))?.consumption.durationMinutes).toBe(1);
      expect((await store.readRun(runId))?.notices).toHaveLength(1);
    } finally { await monitor.close(); }
  });
});

test("duplicate receipts never replay notices/cancel; foreign checkpoints cannot change a run", async () => {
  await fixture(async store => {
    await store.save("task", { ...emptyLimitSettings(), steps: { value: 1, action: "stop" } }, 0);
    let cancelled = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancelled++; }, null);
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 1, maxSteps: 50 });
      await monitor.event("session", runId, step(1, { inputTokens: 10, outputTokens: 20 }));
      await monitor.event("session", runId, step(1, { inputTokens: 10, outputTokens: 20 }));
      await monitor.checkpoint("foreign", runId, "completed");
      expect(monitor.snapshot(runId)?.status).toBe("running");
      expect(monitor.snapshot(runId)?.consumption.tokens).toBe(30);
      expect(monitor.snapshot(runId)?.notices).toHaveLength(1); expect(cancelled).toBe(1);
    } finally { await monitor.close(); }
  });
});
for (const action of ["notify", "stop"] as const) test(`observer storage failure: ${action} preserves diagnostics and cancels only its known active stop once`, async () => {
  await fixture(async store => {
    await store.save("task", { ...emptyLimitSettings(), tokens: { value: 100, action } }, 0);
    let cancelled = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancelled++; }, null);
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 1, maxSteps: 50 });
      store.saveRun = () => Promise.reject(Error("fixture storage failure"));
      await monitor.event("session", runId, step(1, { totalTokens: 1 })).catch(() => monitor.failed(runId));
      await monitor.failed("run_foreign"); await monitor.failed(runId);
      expect(monitor.snapshot(runId)?.observationError).toBe(true);
      expect(cancelled).toBe(action === "stop" ? 1 : 0);
    } finally { await monitor.close(); }
  });
});

for (const name of ["steps", "tokens", "costUsd"] as const) test(`first real SDK step counts ${name} and duplicate events cannot recount it`, async () => {
  await fixture(async store => {
    await store.save("task", { ...emptyLimitSettings(), [name]: { value: name === "costUsd" ? .00001 : 1, action: "stop" } }, 0);
    let cancelled = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancelled++; }, { inputPerMillion: 1, outputPerMillion: 2, source: "fixture" });
    const harness = await createHarness({ workspace: dirname(store.filename), store: createInMemoryAgentRunStore(), subagentProfiles: [],
      modelInstance: createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } }]] }) });
    try {
      await monitor.admitted("session", runId);
      let first: AgentStreamEvent | undefined;
      const result = await runHarness(harness, { runId, prompt: "offline first step accounting" }, { onEvent: async event => {
        if (event.type === "agent-step-finish") first = event;
        await monitor.event("session", runId, event);
      } });
      expect(result.state.steps.map(s => s.index)).toEqual([1]);
      expect(cancelled).toBe(1);
      expect(first).toBeDefined();
      await monitor.event("session", runId, first!);
      const record = await store.readRun(runId);
      expect(record?.consumption).toMatchObject({ steps: 1, tokens: 11, costUsd: .000015 });
      expect(record?.notices).toHaveLength(1);
      expect(record?.notices[0]?.name).toBe(name);
      expect(cancelled).toBe(1);
    } finally { await monitor.close(); await harness.close(); }
  });
});

test("failed run snapshot admission preserves the exact one-shot settings and revision", async () => {
  await fixture(async store => {
    const settings = { ...emptyLimitSettings(), tokens: { value: 10, action: "stop" as const } };
    await store.save("task", settings, 0);
    const previous = await store.read();
    // An unsafe snapshot target reproduces a failure after the old preference write.
    await mkdir(store.filename.replace(/\.json$/, `-${runId}.json`), { mode: 0o700 });
    const monitor = new WebLimitMonitor(store, async () => {}, null);
    try {
      await expect(monitor.admitted("session", runId)).rejects.toThrow();
      expect(await store.read()).toEqual(previous);
      expect(monitor.snapshot(runId)).toBeUndefined();
    } finally { await monitor.close(); }
  });
});

test("runs without duration thresholds avoid idle durable writes and retain event/checkpoint accounting", async () => {
  await fixture(async store => {
    const saveRun = store.saveRun.bind(store);
    let writes = 0;
    store.saveRun = run => { writes++; return saveRun(run); };
    const monitor = new WebLimitMonitor(store, async () => {}, null);
    try {
      await monitor.admitted("session", runId);
      await monitor.event("session", runId, { type: "agent-run-start", currentStep: 0, maxSteps: "unlimited" });
      const beforeIdle = writes;
      await new Promise(resolve => setTimeout(resolve, 650));
      await monitor.checkpoint("session", runId, "waiting_approval");
      expect(writes).toBe(beforeIdle + 1);
      expect((await store.readRun(runId))?.consumption.durationMinutes).toBeGreaterThan(.005);
    } finally { await monitor.close(); }
  });
});
