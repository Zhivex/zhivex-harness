import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { fingerprintAgentHarness, createAgentBudgetCoordinator, type ToolSet } from "@zhivex-ai/core";
import { createHarness } from "../src/runtime/harness.js";
import { runHarnessDurableReviewGroup, inspectHarnessReviewGroup, cancelHarnessReviewGroup } from "../src/runtime/durable-review-group.js";
const sharedBudget = { modelReservation: { inputTokens: 10_000, outputTokens: 1000, totalTokens: 11_000 } };
const input = { groupId: "pooled", prompt: "inspect", sharedBudget };
const receipt = { text: "evidence", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "evidence" }] }], finishReason: "stop" as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
async function fixture(maxTotalTokens = 120_000) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-review-budget-"));
  const store = createInMemoryAgentRunStore(); const calls = { explorer: 0, reviewer: 0 };
  const models = Object.fromEntries((["explorer", "reviewer"] as const).map(role => {
    const model = createMockLanguageModel(); model.generate = async request => { calls[role]++; expect(request.maxTokens).toBeLessThanOrEqual(1000); return receipt; };
    return [role, model];
  }));
  const harness = await createHarness({ provider: "openai", workspace, store, modelInstance: createMockLanguageModel(), subagentModels: models, maxInputTokens: Math.min(100_000, maxTotalTokens), maxOutputTokens: Math.min(30_000, maxTotalTokens), maxTotalTokens });
  const location = { runId: `budget_${fingerprintAgentHarness({ budgetId: "harness-review:pooled", scope: harness.config.scope }).slice("sha256:".length)}`, scope: { ...harness.config.scope, namespace: "__zhivex_budget__" } };
  return { harness, store, calls, location, cleanup: async () => { await harness.close(); await rm(workspace, { recursive: true, force: true }); } };
}

test("durable members use one SDK pool and replay without new reservations", async () => {
  const f = await fixture();
  try {
    const result = await runHarnessDurableReviewGroup(f.harness, input);
    expect(result.status).toBe("completed"); expect(result.sharedBudget?.status).toBe("ready");
    expect(result.members.every(m => m.output?.state.budgetCoordinatorId === result.sharedBudget?.coordinatorId)).toBe(true);
    const ledger = await f.store.load(f.location.runId, f.location.scope);
    const allocations = Object.values(ledger!.metadata!.allocations as Record<string, { tokens: { totalTokens: number } }>);
    expect(allocations).toHaveLength(3); expect(allocations.reduce((sum, a) => sum + a.tokens.totalTokens, 0)).toBe(10);
    expect(await runHarnessDurableReviewGroup(f.harness, input)).toEqual(result);
    expect(await f.store.load(f.location.runId, f.location.scope)).toEqual(ledger);
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    await expect(runHarnessDurableReviewGroup(f.harness, { groupId: input.groupId, prompt: input.prompt })).rejects.toThrow("different request");
    await expect(runHarnessDurableReviewGroup(f.harness, { ...input, sharedBudget: { modelReservation: { ...sharedBudget.modelReservation, outputTokens: 900 } } })).rejects.toThrow("different request");
    await f.store.delete!(f.location.runId, f.location.scope);
    expect((await inspectHarnessReviewGroup(f.harness, input.groupId)).sharedBudget?.status).toBe("missing");
    await expect(runHarnessDurableReviewGroup(f.harness, input)).rejects.toThrow("ledger is missing");
  } finally { await f.cleanup(); }
});

test("a shared group cannot dispatch a member whose reservation exceeds the remaining pool", async () => {
  const f = await fixture(11_000);
  try {
    const result = await runHarnessDurableReviewGroup(f.harness, input);
    expect(result.status).toBe("partial"); expect(f.calls).toEqual({ explorer: 1, reviewer: 0 });
    expect(JSON.stringify(result.members[1]?.output?.error)).toContain("totalTokens");
    expect(result.members[0]?.output?.status).toBe("completed");
  } finally { await f.cleanup(); }
});

test("unknown consumption blocks later admission and retries while retaining its reservation", async () => {
  const f = await fixture();
  try {
    f.harness.subagents.get("explorer")!.model.generate = async () => { f.calls.explorer++; const { usage: _usage, ...withoutUsage } = receipt; return withoutUsage; };
    const result = await runHarnessDurableReviewGroup(f.harness, input);
    expect(result.sharedBudget?.status).toBe("unknown"); expect(result.status).toBe("blocked");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 0 });
    const ledger = await f.store.load(f.location.runId, f.location.scope);
    await expect(runHarnessDurableReviewGroup(f.harness, input)).rejects.toThrow("unknown");
    expect(await f.store.load(f.location.runId, f.location.scope)).toEqual(ledger);
    const cancelled = await cancelHarnessReviewGroup(f.harness, input.groupId);
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.sharedBudget?.status).toBe("unknown");
  } finally { await f.cleanup(); }
});

test("an interrupted unclaimed admission recovers earlier receipts without resetting the pool", async () => {
  const f = await fixture();
  try {
    const claim = f.store.claimIdempotencyKey!.bind(f.store); let cut = true;
    f.store.claimIdempotencyKey = async state => {
      if (cut && state.agentId === "zhivex-harness-reviewer") throw new Error("interrupted claim");
      return claim(state);
    };
    const first = await runHarnessDurableReviewGroup(f.harness, input);
    expect(first.status).toBe("blocked"); expect(first.sharedBudget?.status).toBe("ready");
    cut = false;
    const resumed = await runHarnessDurableReviewGroup(f.harness, input);
    expect(resumed.status).toBe("completed"); expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
  } finally { await f.cleanup(); }
});

test("stale reservations block a recovered group even with unused capacity", async () => {
  const f = await fixture();
  try {
    const claim = f.store.claimIdempotencyKey!.bind(f.store);
    f.store.claimIdempotencyKey = async state => {
      if (state.agentId?.startsWith("zhivex-harness-explorer")) throw new Error("before child checkpoint");
      return claim(state);
    };
    await runHarnessDurableReviewGroup(f.harness, input);
    const coordinator = createAgentBudgetCoordinator({ store: f.store, scope: f.harness.config.scope, budgetId: "harness-review:pooled", limits: {
      inputTokens: f.harness.config.budget.maxInputTokens, outputTokens: f.harness.config.budget.maxOutputTokens, totalTokens: f.harness.config.budget.maxTotalTokens
    } });
    await coordinator.reserve("interrupted-model", sharedBudget.modelReservation);
    expect((await inspectHarnessReviewGroup(f.harness, input.groupId)).sharedBudget?.status).toBe("reserved");
    const calls = { ...f.calls };
    await expect(runHarnessDurableReviewGroup(f.harness, input)).rejects.toThrow("reserved");
    expect(f.calls).toEqual(calls);
  } finally { await f.cleanup(); }
});

for (const known of [true, false]) test(`member auxiliary compaction shares the group pool (known=${known})`, async () => {
  const f = await fixture(); let summaries = 0;
  try {
    const explorer = f.harness.subagents.get("explorer")!;
    let step = 0;
    explorer.model.generate = async () => {
      f.calls.explorer++; step++;
      if (step <= 2) {
        const toolCall = { id: `evidence-${step}`, name: "list_files", input: {} };
        return { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall }] }], toolCalls: [toolCall], finishReason: "tool-calls", usage: receipt.usage };
      }
      return receipt;
    };
    explorer.tools = { list_files: { ...(explorer.tools as ToolSet).list_files!, execute: async () => "evidence ".repeat(500) } };
    explorer.compaction = { maxMessages: 5, keepRecentMessages: 1,
      auxiliary: { provider: "offline", modelId: "summary", fingerprint: "offline-summary-v1", reservation: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      compactor: async () => { summaries++; return { summary: "Retain evidence.", ...(known ? { usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } : {}) }; }
    };
    const result = await runHarnessDurableReviewGroup(f.harness, input);
    expect(summaries).toBe(1);
    expect(result.sharedBudget?.status).toBe(known ? "ready" : "unknown");
    expect(f.calls.reviewer).toBe(known ? 1 : 0);
    const ledger = await f.store.load(f.location.runId, f.location.scope);
    const allocations = Object.values(ledger!.metadata!.allocations as Record<string, { status: string; tokens: { totalTokens: number } }>);
    expect(allocations.some(a => a.tokens.totalTokens === (known ? 22 : 110))).toBe(true);
    expect(result.members[0]?.output?.state.compactionAttempts?.[0]?.status).toBe(known ? "confirmed" : "unknown");
  } finally { await f.cleanup(); }
});

test("terminal root recovery preserves the shared pool and receipt loss cannot reserve a replacement", async () => {
  const f = await fixture(); const h = f.harness;
  try {
    const save = f.store.save.bind(f.store);
    f.store.save = async (state, options) => {
      if (state.runId === input.groupId && state.metadata?.harnessReviewGroupStatusV1 === "completed") throw new Error("cut before shared root projection");
      return save(state, options);
    };
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("cut before shared root projection");
    f.store.save = save;
    const ledger = await f.store.load(f.location.runId, f.location.scope);
    const result = await runHarnessDurableReviewGroup(h, input);
    expect(result.status).toBe("completed"); expect(result.sharedBudget?.status).toBe("ready");
    const root = (await f.store.load(input.groupId, h.config.scope))!;
    expect(root.status).toBe("completed"); expect(root.childRuns).toHaveLength(2);
    expect(root.budgetCoordinatorId).toBe(result.sharedBudget?.coordinatorId);
    expect(await f.store.load(f.location.runId, f.location.scope)).toEqual(ledger);
    await f.store.delete!(result.members[0]!.runId, h.config.scope);
    await expect(runHarnessDurableReviewGroup(h, input)).rejects.toThrow("checkpoint is missing");
    expect(f.calls).toEqual({ explorer: 1, reviewer: 1 });
    expect(await f.store.load(f.location.runId, f.location.scope)).toEqual(ledger);
  } finally { await f.cleanup(); }
});
