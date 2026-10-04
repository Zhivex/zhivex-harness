import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../src/runtime/harness.js";
import { runHarnessDurableReviewGroup, inspectHarnessReviewGroup, cancelHarnessReviewGroup } from "../src/runtime/durable-review-group.js";

const response = { messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "evidence" }] }], text: "evidence", finishReason: "stop" as const,
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
const fixture = async (store = createInMemoryAgentRunStore()) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-durable-review-"));
  const calls = { explorer: 0, reviewer: 0 };
  const models = Object.fromEntries((["explorer", "reviewer"] as const).map(role => {
    const model = createMockLanguageModel({ responses: [response] });
    const generate = model.generate;
    model.generate = async input => { calls[role]++; return generate(input); };
    return [role, model];
  }));
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel(), subagentModels: models, store });
  return { harness, calls, cleanup: async () => { await harness.close(); await rm(workspace, { recursive: true, force: true }); } };
};

test("repeated groups replay exact durable children and reject changed prompts or member order", async () => {
  const f = await fixture();
  try {
    const result = await runHarnessDurableReviewGroup(f.harness, { groupId: "repeat", prompt: "inspect" });
    expect(result.status).toBe("completed");
    expect(result.members.map(m => m.output?.outputText)).toEqual(["evidence", "evidence"]);
    const replay = await runHarnessDurableReviewGroup(f.harness, { groupId: "repeat", prompt: "inspect" });
    expect(replay).toEqual(result);
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    expect(await inspectHarnessReviewGroup(f.harness, "repeat")).toEqual(result);
    await expect(runHarnessDurableReviewGroup(f.harness, { groupId: "repeat", prompt: "changed" })).rejects.toThrow("different request");
    await expect(runHarnessDurableReviewGroup(f.harness, { groupId: "repeat", prompt: "inspect" }, ["reviewer", "explorer"])).rejects.toThrow("different request");
    await cancelHarnessReviewGroup(f.harness, "repeat");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    expect((await inspectHarnessReviewGroup(f.harness, "repeat")).status).toBe("completed");
  } finally { await f.cleanup(); }
});

test("cancellation closes admission while a completed child remains completed", async () => {
  const f = await fixture();
  try {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const reviewer = f.harness.subagents.get("reviewer")!.model;
    const generate = reviewer.generate;
    reviewer.generate = async input => { started(); await blocked; return generate(input); };
    const active = runHarnessDurableReviewGroup(f.harness, { groupId: "cancel", prompt: "inspect" });
    await entered;
    const pending = await cancelHarnessReviewGroup(f.harness, "cancel");
    expect(pending.status).toBe("cancel_requested");
    expect(pending.members[0]?.output?.status).toBe("completed");
    release();
    const done = await active;
    expect(done.status).toBe("cancelled");
    expect(done.members[0]?.output?.status).toBe("completed");
    const calls = { ...f.calls };
    await runHarnessDurableReviewGroup(f.harness, { groupId: "cancel", prompt: "inspect" });
    expect(f.calls).toEqual(calls);
  } finally { await f.cleanup(); }
});

test("a cut after the first member recovers its receipt without a new model call", async () => {
  const f = await fixture();
  try {
    const base = f.harness.store.claimIdempotencyKey!.bind(f.harness.store);
    let cut = true;
    f.harness.store.claimIdempotencyKey = async state => {
      if (state.agentId === "zhivex-harness-reviewer" && cut) throw new Error("simulated interruption before child checkpoint");
      return base(state);
    };
    const partial = await runHarnessDurableReviewGroup(f.harness, { groupId: "cut", prompt: "inspect" });
    expect(partial.status).toBe("blocked");
    expect(partial.members[0]?.output?.status).toBe("completed");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 0 });
    cut = false;
    const resumed = await runHarnessDurableReviewGroup(f.harness, { groupId: "cut", prompt: "inspect" });
    expect(resumed.status).toBe("completed");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
  } finally { await f.cleanup(); }
});

test("cancellation after an interrupted admission remains uncertain instead of confirming a missing child", async () => {
  const f = await fixture();
  try {
    const base = f.harness.store.claimIdempotencyKey!.bind(f.harness.store);
    f.harness.store.claimIdempotencyKey = async state => {
      if (state.agentId === "zhivex-harness-reviewer") throw new Error("cut after admission");
      return base(state);
    };
    await runHarnessDurableReviewGroup(f.harness, { groupId: "uncertain", prompt: "inspect" });
    const cancelled = await cancelHarnessReviewGroup(f.harness, "uncertain");
    expect(cancelled.status).toBe("cancel_requested");
    expect(cancelled.members[0]?.output?.status).toBe("completed");
    expect(cancelled.members[1]?.output).toBeUndefined();
    expect((await runHarnessDurableReviewGroup(f.harness, { groupId: "uncertain", prompt: "inspect" })).status).toBe("cancel_requested");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 0 });
  } finally { await f.cleanup(); }
});

test("concurrent orchestration callers cannot execute the same group twice", async () => {
  const f = await fixture();
  try {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const model = f.harness.subagents.get("explorer")!.model;
    const generate = model.generate;
    model.generate = async input => { started(); await blocked; return generate(input); };
    const active = runHarnessDurableReviewGroup(f.harness, { groupId: "race", prompt: "inspect" });
    await entered;
    await expect(runHarnessDurableReviewGroup(f.harness, { groupId: "race", prompt: "inspect" })).rejects.toThrow("already executing");
    release();
    expect((await active).status).toBe("completed");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
  } finally { await f.cleanup(); }
});

for (const cancel of [false, true]) test(`SQLite fences separate processes and survives restart (cancel=${cancel})`, async () => {
  const { access, writeFile, readFile } = await import("node:fs/promises");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-review-workers-"));
  const workerScript = path.join(import.meta.dir, "fixtures/durable-review-worker.ts");
  const worker = Bun.spawn([process.execPath, workerScript, workspace], { stdout: "pipe", stderr: "pipe" });
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  const open = () => createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel(),
    subagentModels: { explorer: createMockLanguageModel(), reviewer: createMockLanguageModel() } });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await access(path.join(workspace, "entered")); break; } catch {
        if (Date.now() > deadline) throw new Error(`worker did not enter: ${await new Response(worker.stderr).text()}`);
        await new Promise(r => setTimeout(r, 10));
      }
    }
    harness = await open();
    // Read/cancel from a different process and connection while the model is active.
    expect((await inspectHarnessReviewGroup(harness, "worker-group")).status).toBe("running");
    if (cancel) await cancelHarnessReviewGroup(harness, "worker-group");
    else {
      const contender = Bun.spawn([process.execPath, workerScript, workspace], { stdout: "pipe", stderr: "pipe" });
      const stderr = new Response(contender.stderr).text();
      expect(await contender.exited).not.toBe(0);
      expect(await stderr).toContain("already executing");
    }
    await writeFile(path.join(workspace, "release"), "continue");
    const stdout = new Response(worker.stdout).text();
    const stderr = new Response(worker.stderr).text();
    expect(await worker.exited).toBe(0);
    const result = JSON.parse((await stdout).trim());
    expect(result.status).toBe(cancel ? "cancelled" : "completed");
    expect(await readFile(path.join(workspace, "calls.txt"), "utf8")).toBe(cancel ? "explorer\n" : "explorer\nreviewer\n");
    await stderr;
    await harness.close();
    harness = await open();
    const restarted = await runHarnessDurableReviewGroup(harness, { groupId: "worker-group", prompt: "inspect" });
    expect(restarted.status).toBe(result.status);
    expect(restarted.members.map(m => m.runId)).toEqual(result.members.map((m: { runId: string }) => m.runId));
    expect(await readFile(path.join(workspace, "calls.txt"), "utf8")).toBe(cancel ? "explorer\n" : "explorer\nreviewer\n");
  } finally {
    worker.kill();
    await worker.exited;
    await harness?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20_000);

test("partial outcomes retain successful receipts and cannot be mistaken for acceptance", async () => {
  const f = await fixture();
  try {
    f.harness.subagents.get("reviewer")!.model.generate = async () => { throw new Error("offline provider failure"); };
    const result = await runHarnessDurableReviewGroup(f.harness, { groupId: "partial", prompt: "inspect" });
    expect(result.status).toBe("partial");
    expect(result.members[0]?.output?.status).toBe("completed");
    expect(result.members[1]?.output?.status).toBe("failed");
    expect((await f.harness.store.load("partial", f.harness.config.scope))?.metadata?.harnessReviewGroupStatusV1).toBe("partial");
    expect((await runHarnessDurableReviewGroup(f.harness, { groupId: "partial", prompt: "inspect" })).status).toBe("partial");
  } finally { await f.cleanup(); }
});

test("durable groups share the logical monetary ledger across member calls", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-review-ledger-"));
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel(), usageAccounting: {},
    subagentModels: { explorer: createMockLanguageModel({ responses: [response] }), reviewer: createMockLanguageModel({ responses: [response] }) } });
  try {
    expect((await runHarnessDurableReviewGroup(harness, { groupId: "ledger", prompt: "inspect" })).status).toBe("completed");
    expect(harness.usageLedger?.summary("ledger")).toMatchObject({ calls: 2, inputTokens: 6, outputTokens: 4, usageComplete: true });
    await runHarnessDurableReviewGroup(harness, { groupId: "ledger", prompt: "inspect" });
    expect(harness.usageLedger?.summary("ledger").calls).toBe(2);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
