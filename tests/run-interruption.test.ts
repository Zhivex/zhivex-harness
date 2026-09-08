import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/harness.js";
import { settleInterruptedRun } from "../src/run-interruption.js";

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
