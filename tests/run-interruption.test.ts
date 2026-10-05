import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { settleInterruptedRun } from "../src/runtime/run-interruption.js";

test("external interruption persists cancelled and emits one cancelled lifecycle finish", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-interrupt-"));
  const store = createInMemoryAgentRunStore();
  const controller = new AbortController();
  const model = createMockLanguageModel();
  model.stream = async () => (async function* () {
    controller.abort();
    throw new DOMException("private provider detail", "AbortError");
    yield { type: "finish" as const, finishReason: "stop" as const };
  })();
  const finishes: string[] = [];
  const harness = await createHarness({ provider: "openai", workspace: root, store, modelInstance: model,
    lifecycleHooks: [{ id: "test-hook", version: "1", events: ["run-finished"], handle: (event) => {
      if (event.type === "run-finished") finishes.push(event.status);
    } }] });
  try {
    const events: string[] = [];
    const result = await runHarness(harness, { prompt: "stop", abortSignal: controller.signal }, {
      onEvent: (event) => { if (event.type === "agent-run-finish") events.push(event.status); }
    });
    expect(result.status).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect((await store.load(result.state.runId))?.status).toBe("cancelled");
    expect(finishes).toEqual(["cancelled"]);
    expect(events).toEqual(["cancelled"]);
    for (const status of ["completed", "waiting_approval", "timed_out"] as const) {
      const state = { ...result.state, runId: `preserve-${status}`, status, revision: 0 };
      await store.save(state);
      expect(await settleInterruptedRun(store, state.runId)).toBeUndefined();
      expect((await store.load(state.runId))?.status).toBe(status);
    }
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("genuine provider failures remain failures without an external interruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-provider-failure-"));
  const store = createInMemoryAgentRunStore();
  const model = createMockLanguageModel();
  model.stream = async () => { throw new Error("fixture failure"); };
  const harness = await createHarness({ provider: "openai", workspace: root, store, modelInstance: model });
  try {
    await expect(runHarness(harness, { runId: "failure", prompt: "test" })).rejects.toThrow();
    expect((await store.load("failure"))?.status).toBe("failed");
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("observer failure aborts and drains the SDK before rejecting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-observer-"));
  const store = createInMemoryAgentRunStore();
  const model = createMockLanguageModel();
  let cleanupStarted!: () => void, finishCleanup!: () => void;
  const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  let stopped = false, rejected = false;
  model.stream = async input => (async function* () {
    const signal = input.abortSignal!;
    try {
      yield { type: "text-delta" as const, textDelta: "first" };
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield { type: "finish" as const, finishReason: "stop" as const };
    } finally { cleanupStarted(); await cleanup; stopped = true; }
  })();
  const harness = await createHarness({ workspace: root, store, modelInstance: model });
  try {
    const running = runHarness(harness, { runId: "observer", prompt: "test" }, {
      onEvent: event => { if (event.type === "text-delta") throw new Error("observer fixture failure"); }
    }).catch(error => { rejected = true; return error; });
    await started;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rejected).toBe(false);
    finishCleanup();
    expect(String(await running)).toContain("observer fixture failure");
    expect(stopped).toBe(true);
    expect((await store.load("observer"))?.status).toBe("failed");
    expect(await store.acquireLease!("observer", { ownerId: "after-observer", ttlMs: 1000 })).toBeTruthy();
    await store.releaseLease!("observer", "after-observer");
  } finally { finishCleanup(); await harness.close(); await rm(root, { recursive: true, force: true }); }
});

for (const externalAfterTimeout of [false, true]) test(`internal timeout retains timed_out and its cause (late caller=${externalAfterTimeout})`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-timeout-"));
  const store = createInMemoryAgentRunStore(), caller = new AbortController();
  const model = createMockLanguageModel();
  model.stream = async input => (async function* () {
    const signal = input.abortSignal!;
    await new Promise<void>((_resolve, reject) => {
      const stop = () => { if (externalAfterTimeout) caller.abort(); reject(signal.reason); };
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    });
    yield { type: "finish" as const, finishReason: "stop" as const };
  })();
  const finishes: string[] = [], events: string[] = [];
  const harness = await createHarness({ workspace: root, store, modelInstance: model,
    lifecycleHooks: [{ id: "timeout-test", version: "1", events: ["run-finished"], handle: event => {
      if (event.type === "run-finished") finishes.push(event.status);
    } }] });
  try {
    const result = await runHarness(harness, { runId: "timeout", prompt: "test", timeoutMs: 20, abortSignal: caller.signal }, {
      onEvent: event => { if (event.type === "agent-run-finish") events.push(event.status); }
    });
    expect(result.status).toBe("timed_out");
    expect(result.state.cancellationReason).toBeUndefined();
    expect(result.state.cancelledAt).toBeUndefined();
    expect(result.error?.message).toBe("Run exceeded its time limit.");
    expect((await store.load("timeout"))?.status).toBe("timed_out");
    expect(finishes).toEqual(["timed_out"]);
    expect(events).toEqual(["timed_out"]);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
