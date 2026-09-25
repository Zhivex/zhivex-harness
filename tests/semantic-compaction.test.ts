import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createTextMessage, type AgentCompactionRequest } from "@zhivex-ai/core";
import { createSemanticCompactor } from "../src/context/semantic-compaction.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { harnessConfigInput } from "../src/cli/resume-metadata.js";

const messages = [createTextMessage("user", "Keep compatibility. " + "Old analysis. ".repeat(1500)),
  createTextMessage("assistant", "Rejected replacing the schema because old clients depend on it. ".repeat(200)),
  createTextMessage("user", "Proceed carefully."), createTextMessage("assistant", "Inspect first."),
  createTextMessage("user", "Continue.")];
const request: AgentCompactionRequest = { runId: "r", beforeStep: 1, messages,
  retainedMessages: [], reasons: ["message-count"], estimatedTokensBefore: 9000, sourceDigest: "source", idempotencyKey: "cmp" };

test("semantic compactor uses selected model without tools and returns usage with untrusted bounded summary", async () => {
  const model = createMockLanguageModel({ responses: [{ text: "Keep compatibility; inspect existing schema. " + "x".repeat(5000), usage: { inputTokens: 40, outputTokens: 5 } }] });
  const original = model.generate;
  let called = false;
  model.generate = async input => { called = true; expect(input.tools).toBeUndefined(); expect(input.maxRetries).toBe(0);
    expect(JSON.stringify(input.messages).length).toBeLessThan(30_000); return original(input); };
  const result = await createSemanticCompactor(model)(request);
  expect(called).toBe(true); expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 5 });
  expect(result.summary).toContain("never authorization"); expect(result.summary.length).toBeLessThan(4000);
});

test("unknown usage and pre-cancelled compaction fail instead of silently retrying", async () => {
  const model = createMockLanguageModel({ responses: [{ text: "summary" }] });
  model.generate = async () => ({ text: "summary", finishReason: "stop" });
  await expect(createSemanticCompactor(model)(request)).rejects.toThrow("COMPACTION_USAGE_UNAVAILABLE");
  let calls = 0; model.generate = async () => { calls++; return { text: "x" }; };
  await expect(createSemanticCompactor(model)({ ...request, abortSignal: AbortSignal.abort() })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("runtime charges auxiliary model once and preserves explicit route in resume configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hybrid-context-"));
  const parent = createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "done" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }]] });
  const utility = createMockLanguageModel({ responses: [{ text: "Preserve compatibility; rejected schema rewrite.",
    usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } }] });
  const store = createInMemoryAgentRunStore();
  const generate = utility.generate;
  utility.generate = async input => {
    const saved = await store.load("durable-utility");
    expect(saved?.compactionAttempts?.[0]?.status).toBe("in-flight");
    return generate(input);
  };
  const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: parent,
    compactionModel: "chosen-small-model", compactionModelInstance: utility,
    subagentProfiles: [], store, compactionMaxMessages: 4, compactionKeepRecentMessages: 2 });
  try {
    const result = await runHarness(harness, { messages, runId: "durable-utility" });
    expect(result.status).toBe("completed");
    expect(result.usage).toMatchObject({ inputTokens: 140, outputTokens: 25 });
    expect(result.state.compactions?.[0]?.metadata?.strategy).toBe("hybrid-context-v1");
    expect(result.state.compactionAttempts).toHaveLength(1);
    expect(result.state.compactionAttempts?.[0]).toMatchObject({ status: "confirmed", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } });
    expect(harness.usageLedger?.summary(result.state.runId)).toMatchObject({ calls: 2, inputTokens: 140, outputTokens: 25 });
    expect(harnessConfigInput(harness.config)).toMatchObject({ compactionModel: "chosen-small-model", compactionProvider: "openai" });
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("CLI accepts an explicit utility route", () => {
  expect(parseCliArgs(["run", "--compaction-provider", "qwen", "--compaction-model", "my-model", "task"]))
    .toMatchObject({ compactionProvider: "qwen", compactionModel: "my-model" });
});

for (const scenario of ["over-budget", "rejected-summary", "partial-usage"] as const) {
  test(`utility accounting survives ${scenario} and the primary model is not invoked`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "utility-accounting-"));
    const store = createInMemoryAgentRunStore();
    let primaryCalls = 0, utilityCalls = 0;
    const primary = createMockLanguageModel();
    primary.stream = async () => { primaryCalls++; throw new Error("Primary model must not execute"); };
    const utility = createMockLanguageModel();
    const usage = scenario === "over-budget" ? { inputTokens: 40, outputTokens: 1025, totalTokens: 1065 } :
      scenario === "partial-usage" ? { inputTokens: 40 } : { inputTokens: 40, outputTokens: 5, totalTokens: 45 };
    utility.generate = async () => { utilityCalls++; return { text: "Remember compatibility and rejected rewrite.", finishReason: "stop", usage }; };
    const harness = await createHarness({ workspace: root, provider: "openai", store, modelInstance: primary,
      compactionModel: "small", compactionModelInstance: utility, subagentProfiles: [],
      maxOutputTokens: 2000, compactionMaxMessages: 4, compactionKeepRecentMessages: 2,
      ...(scenario === "rejected-summary" ? { compactionMaxEstimatedInputTokens: 1000 } : {}) });
    try {
      await expect(runHarness(harness, { runId: scenario, messages })).rejects.toThrow(
        scenario === "over-budget" ? "reservation" : scenario === "partial-usage" ? "COMPACTION_USAGE_UNAVAILABLE" : "compaction");
      expect(utilityCalls).toBe(1); expect(primaryCalls).toBe(0);
      const state = await store.load(scenario);
      expect(state?.status).toBe("failed");
      expect(state?.compactionAttempts?.[0]?.status).toBe(scenario === "partial-usage" ? "unknown" : "confirmed");
      expect(state?.usage?.inputTokens).toBe(40);
      expect(state?.compactions?.length ?? 0).toBe(0);
      const ledger = harness.usageLedger!.summary(scenario);
      expect(ledger.calls).toBe(1);
      expect(ledger.inputTokens).toBe(40);
      expect(ledger.usageComplete).toBe(scenario !== "partial-usage");
      if (scenario !== "partial-usage") {
        expect(state?.usage?.outputTokens).toBe(usage.outputTokens!);
        expect(ledger.outputTokens).toBe(usage.outputTokens!);
      }
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("SDK reservation rejects an unaffordable utility call before billing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "utility-reservation-"));
  let calls = 0;
  const utility = createMockLanguageModel();
  utility.generate = async () => { calls++; throw new Error("Must not bill"); };
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({ workspace: root, provider: "openai", store,
    modelInstance: createMockLanguageModel(), compactionModel: "small", compactionModelInstance: utility,
    subagentProfiles: [], maxOutputTokens: 100, compactionMaxMessages: 4, compactionKeepRecentMessages: 2 });
  try {
    await expect(runHarness(harness, { runId: "unaffordable", messages })).rejects.toThrow("reservation");
    expect(calls).toBe(0);
    expect(harness.usageLedger!.summary("unaffordable").calls).toBe(0);
    expect((await store.load("unaffordable"))?.compactionAttempts ?? []).toHaveLength(0);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("multibyte utility prompts obey the conservative input reservation", async () => {
  const model = createMockLanguageModel();
  model.generate = async input => {
    expect(Buffer.byteLength(JSON.stringify(input.messages), "utf8")).toBeLessThanOrEqual(30_976);
    return { text: "Preserve evidence", usage: { inputTokens: 20, outputTokens: 5 } };
  };
  const output = await createSemanticCompactor(model)({ ...request,
    messages: Array.from({ length: 20 }, () => createTextMessage("user", "漢字🙂".repeat(1500))) });
  expect(output.usage?.totalTokens).toBe(25);
  expect(output.metadata?.sourceTruncated).toBe(true);
});
