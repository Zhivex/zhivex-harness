import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createAgentBudgetCoordinator } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../src/runtime/harness.js";
const reservation = { inputTokens: 20_000, outputTokens: 1000, totalTokens: 21_000 };
const childReservation = { inputTokens: 10_000, outputTokens: 1000, totalTokens: 11_000 };
const options = { sharedBudget: { modelReservation: reservation, childModelReservation: childReservation } };
const childResponse = { messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "child evidence" }] }],
  text: "child evidence", finishReason: "stop" as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
const parent = () => createMockLanguageModel({ streamEvents: [[
  { type: "tool-call", toolCall: { id: "explore", name: "delegate_explorer", input: { prompt: "inspect" } } },
  { type: "tool-call", toolCall: { id: "review", name: "delegate_reviewer", input: { prompt: "review" } } },
  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
], [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]] });

for (const shared of [false, true]) test(`semantic compaction with subagents uses a compatible execution path (shared=${shared})`, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-compaction-"));
  let active = 0, peak = 0;
  const child = () => {
    const model = createMockLanguageModel({ responses: [childResponse] }); const generate = model.generate;
    model.generate = async input => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5));
      try { return await generate(input); } finally { active--; } };
    return model;
  };
  const utility = createMockLanguageModel({ responses: [{ text: "Keep the requested scope.", finishReason: "stop", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } }] });
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: parent(),
    subagentModels: { explorer: child(), reviewer: child() }, subagentProfiles: ["explorer", "reviewer"],
    compactionModel: "utility", compactionModelInstance: utility, compactionMaxMessages: 12, compactionKeepRecentMessages: 2 });
  try {
    const result = await runHarness(harness, { runId: "compatible", messages: Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      parts: [{ type: "text" as const, text: "Keep the requested scope and compatibility. ".repeat(30) }]
    })) }, shared ? options : {});
    expect(result.status).toBe("completed");
    expect(result.state.childRuns).toHaveLength(2);
    expect(result.state.childRuns?.every(c => c.status === "completed")).toBe(true);
    expect(result.state.compactionAttempts?.every(a => a.status === "confirmed")).toBe(true);
    if (!shared) expect(peak).toBe(1);
    else {
      expect(result.state.budgetCoordinatorId).toBeDefined();
      const childState = await harness.store.load(result.state.childRuns![0]!.runId, harness.config.scope);
      expect(childState?.metadata?.sharedBudgetV1).toMatchObject({ allocation: { inputTokens: 28_000, outputTokens: 8000, totalTokens: 36_000 } });
      expect(childState?.budgetCoordinatorId).toBeDefined();
      const replay = await runHarness(harness, { state: result.state }, options);
      expect(replay.status).toBe("completed");
      await expect(runHarness(harness, { state: result.state })).rejects.toThrow("different shared budget coordinator");
      await expect(runHarness(harness, { state: result.state }, { sharedBudget: { ...options.sharedBudget, modelReservation: { ...reservation, inputTokens: 19_000 } } })).rejects.toThrow("original reservation");
    }
    expect(harness.usageLedger!.summary("compatible").usageComplete).toBe(true);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("unknown primary usage retains its reservation before any child can execute", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-unknown-"));
  let children = 0;
  const model = createMockLanguageModel();
  model.generate = async () => { children++; return childResponse; };
  const main = createMockLanguageModel({ streamEvents: [[
    { type: "tool-call", toolCall: { id: "unknown", name: "delegate_explorer", input: { prompt: "inspect" } } },
    { type: "finish", finishReason: "tool-calls" }
  ]] });
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: main, subagentProfiles: ["explorer"], subagentModels: { explorer: model } });
  try {
    await expect(runHarness(harness, { runId: "unknown", prompt: "inspect" }, options)).rejects.toThrow("unknown");
    expect(children).toBe(0);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("invalid request bounds and legacy usage cannot open a new shared pool", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-admission-"));
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]] }), store: createInMemoryAgentRunStore(), subagentProfiles: [] });
  try {
    await expect(runHarness(harness, { prompt: "inspect" }, { sharedBudget: { modelReservation: { ...reservation, totalTokens: 10 } } })).rejects.toThrow("total must cover");
    const result = await runHarness(harness, { runId: "legacy", prompt: "inspect" });
    await expect(runHarness(harness, { state: result.state }, options)).rejects.toThrow("legacy usage");
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("SDK shared reservations remain atomic and unknown across SQLite connections and reopen", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-store-"));
  const open = () => createHarness({ provider: "openai", workspace, modelInstance: createMockLanguageModel(), subagentProfiles: [] });
  let first = await open(), second = await open();
  const limits = { inputTokens: 15, outputTokens: 10, totalTokens: 25 }, request = { inputTokens: 15, outputTokens: 5, totalTokens: 20 };
  const coordinator = (h: typeof first) => createAgentBudgetCoordinator({ store: h.store, scope: h.config.scope, budgetId: "concurrent", limits });
  try {
    const outcomes = await Promise.allSettled([coordinator(first).reserve("a", request), coordinator(second).reserve("b", request)]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0]?.status === "fulfilled" ? "a" : "b";
    await expect(coordinator(first).settle(winner)).rejects.toThrow("unknown");
    await first.close(); await second.close();
    first = await open(); second = await open();
    await expect(coordinator(first).reserve("after-restart", request)).rejects.toThrow("exceeds");
    await expect(coordinator(second).reserve(winner, request)).rejects.toThrow("already reserved");
  } finally { await first.close(); await second.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("a child lifetime allocation cannot exceed the shared parent authorization", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-fanout-"));
  let childCalls = 0;
  const model = createMockLanguageModel(); model.generate = async () => { childCalls++; return childResponse; };
  const harness = await createHarness({ provider: "openai", workspace, modelInstance: parent(),
    subagentProfiles: ["explorer", "reviewer"], subagentModels: { explorer: model, reviewer: model },
    maxInputTokens: 30_000, maxOutputTokens: 10_000, maxTotalTokens: 35_000 });
  try {
    const result = await runHarness(harness, { runId: "small-pool", prompt: "inspect" }, options);
    expect(childCalls).toBe(0);
    expect(result.toolResults.filter(t => t.isError)).toHaveLength(2);
    expect(JSON.stringify(result.toolResults)).toContain("Shared budget reservation exceeds totalTokens");
    expect(harness.config.budget.maxTotalTokens).toBe(35_000);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("restoring only a run snapshot cannot reset its shared budget ledger", async () => {
  const { fingerprintAgentHarness } = await import("@zhivex-ai/core");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-budget-restore-"));
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({ provider: "openai", workspace, store, subagentProfiles: [], modelInstance: createMockLanguageModel({ streamEvents: [[
    { type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  ]] }) });
  try {
    const result = await runHarness(harness, { runId: "restore", prompt: "inspect" }, options);
    const ledgerId = `budget_${fingerprintAgentHarness({ budgetId: "harness:restore", scope: harness.config.scope }).slice("sha256:".length)}`;
    await store.delete!(ledgerId, { ...harness.config.scope, namespace: "__zhivex_budget__" });
    await expect(runHarness(harness, { state: result.state }, options)).rejects.toThrow("ledger is missing");
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
