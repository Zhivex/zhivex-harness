import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../src/runtime/harness.js";
import { runHarnessDurableReviewGroup, inspectHarnessReviewGroup, cancelHarnessReviewGroup } from "../src/runtime/durable-review-group.js";
import { listHarnessRuns, inspectHarnessRun, cleanupHarnessRuns } from "../src/persistence/operations.js";
const receipt = { text: "evidence", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "evidence" }] }], finishReason: "stop" as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
async function fixture(workspace?: string) {
  workspace ??= await mkdtemp(path.join(os.tmpdir(), "review-retention-"));
  const calls = { explorer: 0, reviewer: 0 };
  const models = Object.fromEntries((["explorer", "reviewer"] as const).map(role => {
    const model = createMockLanguageModel(); model.generate = async () => { calls[role]++; return receipt; }; return [role, model];
  }));
  const harness = await createHarness({ workspace, provider: "openai", modelInstance: createMockLanguageModel(), subagentModels: models });
  const workers = async () => (await listHarnessRuns(harness.store, harness.config)).runs.filter(r => r.agentId === "zhivex-harness-review-worker");
  return { harness, calls, workers, cleanup: async () => { await harness.close(); await rm(workspace!, { recursive: true, force: true }); } };
}

for (const failed of [false, true]) test(`terminal replay repairs the root and worker after a final-save cut (partial=${failed})`, async () => {
  const f = await fixture(); const h = f.harness;
  const input = { groupId: "cut", prompt: "inspect" };
  try {
    if (failed) h.subagents.get("reviewer")!.model.generate = async () => { f.calls.reviewer++; throw new Error("offline failure"); };
    const save = h.store.save.bind(h.store);
    h.store.save = async (state, options) => {
      if (state.runId === input.groupId) {
        const record = state.metadata?.harnessReviewGroupV1 as { members: { runId: string }[] };
        const children = await Promise.all(record.members.map(m => h.store.load(m.runId, h.config.scope)));
        if (children.every(c => c && ["completed", "failed"].includes(c.status))) throw new Error("cut before root finalization");
      }
      return save(state, options);
    };
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("cut before root finalization");
    h.store.save = save;
    expect((await inspectHarnessRun(h.store, h.config, input.groupId)).run.status).toBe("queued");
    expect((await f.workers())[0]?.status).toBe("suspended");
    const replay = await runHarnessDurableReviewGroup(h, input);
    expect(replay.status).toBe(failed ? "partial" : "completed");
    const root = (await h.store.load(input.groupId, h.config.scope))!;
    expect(root.status).toBe(failed ? "failed" : "completed"); expect(root.childRuns).toHaveLength(2);
    expect(root.metadata?.harnessReviewGroupStatusV1).toBe(replay.status);
    expect((await inspectHarnessRun(h.store, h.config, input.groupId)).run.childRuns).toBe(2);
    expect((await f.workers())[0]).toMatchObject({ status: root.status, parentRunId: input.groupId });
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    // Retention of older children while a newer root remains must never replay
    // transport. Keep newer root/worker timestamps to exercise the actual default cleanup.
    for (const state of [root, (await h.store.load((await f.workers())[0]!.runId, h.config.scope))!]) {
      await h.store.save({ ...state, revision: (state.revision ?? 0) + 1, updatedAt: Date.now() + 10_000 }, { expectedRevision: state.revision ?? 0 });
    }
    expect((await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 5000 })).deleted).toBe(2);
    expect((await inspectHarnessReviewGroup(h, input.groupId)).status).toBe("blocked");
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("checkpoint is missing");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    const cleanup = await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 20_000 });
    expect(cleanup.deleted).toBe(2); expect((await listHarnessRuns(h.store, h.config)).runs).toHaveLength(0);
  } finally { await f.cleanup(); }
});

for (const cancel of [false, true]) test(`worker lifecycle is running then terminal, with default cleanup safe during execution (cancel=${cancel})`, async () => {
  const f = await fixture(); const h = f.harness;
  try {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    h.subagents.get("explorer")!.model.generate = async () => { f.calls.explorer++; entered(); await hold; return receipt; };
    const active = runHarnessDurableReviewGroup(h, { groupId: "lifecycle", prompt: "inspect" });
    await started;
    expect((await f.workers())[0]).toMatchObject({ status: "running", parentRunId: "lifecycle" });
    expect((await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 1000 })).deleted).toBe(0);
    if (cancel) await cancelHarnessReviewGroup(h, "lifecycle");
    release();
    expect((await active).status).toBe(cancel ? "cancelled" : "completed");
    expect((await f.workers())[0]?.status).toBe(cancel ? "cancelled" : "completed");
    await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 1000 });
    expect((await listHarnessRuns(h.store, h.config)).runs).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("cleanup during an active group cannot replace an already checkpointed member", async () => {
  const f = await fixture(); const h = f.harness;
  try {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    h.subagents.get("reviewer")!.model.generate = async () => { f.calls.reviewer++; entered(); await hold; return receipt; };
    const active = runHarnessDurableReviewGroup(h, { groupId: "retained", prompt: "inspect" });
    await started;
    expect((await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 1000 })).deleted).toBe(1);
    release(); expect((await active).status).toBe("blocked");
    expect((await f.workers())[0]?.status).toBe("suspended");
    await expect(runHarnessDurableReviewGroup(h, { groupId: "retained", prompt: "inspect" })).rejects.toThrow("checkpoint is missing");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    const cancelled = await cancelHarnessReviewGroup(h, "retained");
    expect(cancelled.status).toBe("cancel_requested");
  } finally { await f.cleanup(); }
});

test("legacy admitted members without checkpoint markers cannot be restarted after receipt loss", async () => {
  const f = await fixture(); const h = f.harness;
  try {
    const input = { groupId: "legacy", prompt: "inspect" };
    const result = await runHarnessDurableReviewGroup(h, input);
    const root = (await h.store.load(input.groupId, h.config.scope))!;
    const record = root.metadata?.harnessReviewGroupV1 as { members: { checkpointed?: boolean }[] };
    for (const member of record.members) delete member.checkpointed;
    await h.store.save({ ...root, metadata: { ...root.metadata, harnessReviewGroupV1: record }, revision: (root.revision ?? 0) + 1 }, { expectedRevision: root.revision ?? 0 });
    expect((await runHarnessDurableReviewGroup(h, input)).status).toBe("completed");
    await h.store.delete!(result.members[0]!.runId, h.config.scope);
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("checkpoint is missing");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
  } finally { await f.cleanup(); }
});

test("a process crash after child completion recovers both projections after lease expiry", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "review-crash-"));
  await writeFile(path.join(workspace, "release"), "continue");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/durable-review-worker.ts"), workspace, "crash-after-children"], { stdout: "pipe", stderr: "pipe" });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(77); await stderr;
    f = await fixture(workspace); const h = f.harness;
    const acquire = h.store.acquireLease!.bind(h.store);
    h.store.acquireLease = (id, options, scope) => acquire(id, { ...options, now: Date.now() + 31_000 }, scope);
    const replay = await runHarnessDurableReviewGroup(h, { groupId: "worker-group", prompt: "inspect" });
    expect(replay.status).toBe("completed");
    expect((await inspectHarnessRun(h.store, h.config, "worker-group")).run).toMatchObject({ status: "completed", childRuns: 2 });
    expect((await f.workers())[0]).toMatchObject({ status: "completed", parentRunId: "worker-group" });
    expect(f.calls).toEqual({ explorer: 0, reviewer: 0 });
    expect(await readFile(path.join(workspace, "calls.txt"), "utf8")).toBe("explorer\nreviewer\n");
  } finally { child.kill(); await child.exited; if (f) await f.cleanup(); else await rm(workspace, { recursive: true, force: true }); }
}, 20_000);

test("a stale root claim cannot hide receipt loss from a concurrent replay", async () => {
  const f = await fixture(); const h = f.harness;
  try {
    const input = { groupId: "stale", prompt: "inspect" };
    const result = await runHarnessDurableReviewGroup(h, input);
    const root = (await h.store.load(input.groupId, h.config.scope))!;
    const record = structuredClone(root.metadata?.harnessReviewGroupV1) as { members: { admitted: boolean; checkpointed?: boolean }[] };
    for (const member of record.members) { member.admitted = false; member.checkpointed = false; }
    const claim = h.store.claimIdempotencyKey!.bind(h.store);
    h.store.claimIdempotencyKey = state => state.runId === input.groupId
      ? Promise.resolve({ claimed: false, state: { ...root, metadata: { ...root.metadata, harnessReviewGroupV1: record } } }) : claim(state);
    await h.store.delete!(result.members[0]!.runId, h.config.scope);
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("checkpoint is missing");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
  } finally { await f.cleanup(); }
});

test("cleanup between root projection and worker finalization cannot leave an orphan active worker", async () => {
  const f = await fixture(); const h = f.harness;
  try {
    const load = h.store.load.bind(h.store); let retained = false;
    h.store.load = async (id, scope) => {
      const state = await load(id, scope);
      if (id === "finalize-race" && state?.metadata?.harnessReviewGroupStatusV1 === "completed" && !retained) {
        retained = true;
        await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 1000 });
        return undefined;
      }
      return state;
    };
    expect((await runHarnessDurableReviewGroup(h, { groupId: "finalize-race", prompt: "inspect" })).status).toBe("completed");
    expect(retained).toBe(true); expect((await f.workers())[0]?.status).toBe("completed");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    expect((await cleanupHarnessRuns(h.store, h.config, { before: Date.now() + 1000 })).deleted).toBe(1);
    expect((await listHarnessRuns(h.store, h.config)).runs).toHaveLength(0);
  } finally { await f.cleanup(); }
});
