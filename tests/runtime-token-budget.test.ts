import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { createCheckpointTokenCap } from "../src/runtime/runtime-policy.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { estimateRequestTokens } from "../src/runtime/model-budget.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";

for (const provider of ["meta", "openai", "qwen"] as const) {
  for (const outputLimit of [4, 2]) {
    test(`${provider} recalculates output caps and stops at ${outputLimit} tokens`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-"));
      const caps: (number | undefined)[] = [];
      const model = createMockLanguageModel({ streamEvents: [
        [{ type: "tool-call", toolCall: { id: "list", name: "list_files", input: {} } },
          { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
        [{ type: "text-delta", textDelta: "done" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }]
      ] });
      const stream = model.stream!;
      model.stream = input => { caps.push(input.maxTokens); return stream(input); };
      const harness = await createHarness({ workspace: root, provider, modelInstance: model,
        store: createInMemoryAgentRunStore(), subagentProfiles: [], maxOutputTokens: outputLimit });
      try {
        let failed = false;
        try { const result = await runHarness(harness, { prompt: "List then finish." });
          failed = result.status === "failed";
          if (outputLimit === 4) expect(result.outputText).toBe("done");
        } catch (error) { failed = true; expect(String(error)).toContain("maxOutputTokens"); }
        expect(failed).toBe(outputLimit === 2);
        expect(caps).toEqual(provider === "qwen"
          ? (outputLimit === 4 ? [undefined, undefined] : [undefined])
          : outputLimit === 4 ? [4, 2] : [2]);
      } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
  test(`${provider} preserves consumed tokens across approval resume`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-resume-"));
    const changes = [{ path: "created.txt", expectedDigest: null, content: "approved" }];
    const proposal = createEditProposal({ changes });
    const caps: (number | undefined)[] = [];
    const model = createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "edit", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
      [{ type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }]
    ] });
    const stream = model.stream!;
    model.stream = input => { caps.push(input.maxTokens); return stream(input); };
    const harness = await createHarness({ workspace: root, provider, modelInstance: model,
      store: createInMemoryAgentRunStore(), subagentProfiles: [], maxOutputTokens: 8 });
    try {
      const waiting = await runHarness(harness, { prompt: "Create then finish.", maxTokens: 5 });
      expect(waiting.status).toBe("waiting_approval");
      const result = await runHarness(harness, { state: waiting.state, maxTokens: 7,
        approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
      expect(result.status).toBe("completed");
      expect(result.usage?.outputTokens).toBe(4);
      expect(caps).toEqual(provider === "qwen" ? [5, 7] : [5, 6]);
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("an over-budget response cannot execute its requested tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-cap-overrun-"));
  const store = createInMemoryAgentRunStore();
  const harness = await createHarness({ workspace: root, provider: "openai", store,
    subagentProfiles: [], maxOutputTokens: 2,
    modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: "tool-call", toolCall: { id: "over", name: "list_files", input: {} } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 } }
    ]] }) });
  try {
    await expect(runHarness(harness, { runId: "overrun", prompt: "List." })).rejects.toThrow("maxOutputTokens");
    expect((await store.load("overrun"))?.toolResults).toEqual([]);
    expect((await store.load("overrun"))?.usage).toEqual({ inputTokens: 1, outputTokens: 3, totalTokens: 4 });
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

 test("Qwen stops on cumulative input usage before executing over-budget tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qwen-input-cap-"));
  const store = createInMemoryAgentRunStore();
  let calls = 0;
  const model = createMockLanguageModel({ streamEvents: [1, 2, 3].map(index => [
    { type: "tool-call" as const, toolCall: { id: `list-${index}`, name: "list_files", input: {} } },
    { type: "finish" as const, finishReason: "tool-calls" as const,
      usage: { inputTokens: 60000, outputTokens: 1, totalTokens: 60001 } }
  ]) });
  const stream = model.stream!;
  model.stream = input => { calls++; expect(input.maxTokens).toBeUndefined(); return stream(input); };
  const harness = await createHarness({ workspace: root, provider: "qwen", store,
    subagentProfiles: [], maxInputTokens: 100000, modelInstance: model });
  try {
    await expect(runHarness(harness, { runId: "qwen-overrun", prompt: "List." }))
      .rejects.toThrow("maxInputTokens");
    expect(calls).toBe(2);
    expect((await store.load("qwen-overrun"))?.toolResults).toHaveLength(1);
    expect((await store.load("qwen-overrun"))?.usage?.inputTokens).toBe(120000);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("default runtime reserves a final answer after substantial cumulative input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budget-closure-"));
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "list", name: "list_files", input: {} } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 70000, outputTokens: 100, totalTokens: 70100 } }],
    [{ type: "text-delta", textDelta: "Partial analysis; further inspection remains unverified." },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10000, outputTokens: 100, totalTokens: 10100 } }]
  ] });
  let calls = 0;
  const stream = model.stream!;
  model.stream = input => {
    if (++calls === 2) {
      expect(input.tools).toBeUndefined();
      expect(input.toolChoice).toBeUndefined();
      expect(JSON.stringify(input.messages)).toContain("what remains unverified");
    }
    return stream(input);
  };
  const harness = await createHarness({ workspace: root, provider: "meta", modelInstance: model,
    store: createInMemoryAgentRunStore(), subagentProfiles: [] });
  try {
    const result = await runHarness(harness, { prompt: "Analyze the repository." });
    expect(result.status).toBe("completed");
    expect(result.usage?.inputTokens).toBe(80000);
    expect(calls).toBe(2);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["generate", "stream"] as const) {
  test(`${mode}: rejects the next input before a provider call when cumulative budget cannot fit it`, async () => {
    const budget = resolveHarnessConfig().budget;
    const guard = createCheckpointTokenCap(budget, async () => ({
      inputTokens: 99000, outputTokens: 10, totalTokens: 99010
    }));
    const context = { model: createMockLanguageModel(), input: { messages: [
      { role: "user" as const, parts: [{ type: "text" as const, text: "x".repeat(6000) }] }
    ] } };
    let called = false;
    const next = async () => { called = true; throw new Error("must not call provider"); };
    await expect(mode === "generate" ? guard.wrapGenerate!(context, next) :
      guard.wrapStream!(context, next)).rejects.toThrow("maxInputTokens budget exhausted");
    expect(called).toBe(false);
    expect(guard.observed.inputTokens).toBe(99000);
  });
}

test("total-token preflight reserves input before assigning an output cap", async () => {
  const budget = { ...resolveHarnessConfig().budget, maxTotalTokens: 100000 };
  const guard = createCheckpointTokenCap(budget, async () => ({
    inputTokens: 99000, outputTokens: 500, totalTokens: 99500
  }));
  const context = { model: createMockLanguageModel(), input: { messages: [], maxTokens: 1000 } };
  await guard.wrapGenerate!(context, async () => ({ text: "done", finishReason: "stop",
    usage: { inputTokens: 64, outputTokens: 1, totalTokens: 65 } }));
  expect(context.input.maxTokens).toBe(500 - estimateRequestTokens({ messages: [] }));
});

test("default runtime compaction tracks consumption within the current invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budget-compaction-"));
  await writeFile(path.join(root, "a.txt"), "a".repeat(18000));
  await writeFile(path.join(root, "b.txt"), "b".repeat(18000));
  const model = createMockLanguageModel({ streamEvents: [
    ...["a", "b"].map((name, index) => [
      { type: "tool-call" as const, toolCall: { id: name, name: "read_file", input: { path: name + ".txt" } } },
      { type: "finish" as const, finishReason: "tool-calls" as const,
        usage: { inputTokens: index === 0 ? 25000 : 40000, outputTokens: 100, totalTokens: (index === 0 ? 25000 : 40000) + 100 } }
    ]),
    [{ type: "text-delta", textDelta: "Partial analysis." },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10000, outputTokens: 100, totalTokens: 10100 } }]
  ] });
  const harness = await createHarness({ workspace: root, provider: "meta", modelInstance: model,
    store: createInMemoryAgentRunStore(), subagentProfiles: [] });
  try {
    const result = await runHarness(harness, { prompt: "Analyze both files." });
    expect(result.status).toBe("completed");
    expect(result.state.compactions?.length).toBeGreaterThan(0);
    expect(result.usage?.inputTokens).toBe(75000);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
