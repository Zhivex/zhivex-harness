import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { parseCliArgs } from "../src/cli/arguments.js";
import { createHarnessResumeMetadata, readHarnessResumeConfig } from "../src/cli/resume-metadata.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { createModelBudget, workBudgetReached } from "../src/runtime/model-budget.js";
import { createRepairProgress } from "../src/runtime/repair-progress.js";
import { childRuntimeSafety, effectiveRuntimeBudget } from "../src/runtime/runtime-policy.js";
import { inspectRuntimeManifest } from "../src/runtime/runtime-diagnostics.js";
import { runtimeManifest } from "../src/runtime/runtime-policy.js";
import { inspectHarnessRun } from "../src/persistence/operations.js";
import { createEditProposal } from "../src/workspace/edit-contracts.js";

test("CLI, JSON resume and child policy preserve unlimited mode without disabling other guards", () => {
  for (const args of [["--no-token-budget"], ["run", "--no-token-budget", "task"], ["review", "--no-token-budget", "task"]]) {
    expect(parseCliArgs(args).unlimitedTokens).toBe(true);
  }
  const config = resolveHarnessConfig({ unlimitedTokens: true });
  const metadata = JSON.parse(JSON.stringify(createHarnessResumeMetadata(config)));
  const restored = resolveHarnessConfig(readHarnessResumeConfig({ metadata }));
  expect(restored.budget.unlimitedTokens).toBe(true);
  expect(restored.orchestration.childBudget.unlimitedTokens).toBe(true);
  expect(effectiveRuntimeBudget(restored.budget)).toEqual({ maxSteps: 50, maxToolCalls: 32, maxToolErrors: 4, includeChildRuns: true });
  expect(childRuntimeSafety(restored).budget).not.toHaveProperty("maxInputTokens");
  expect(inspectRuntimeManifest(runtimeManifest(restored, []))?.budget.unlimitedTokens).toBe(true);
  expect(effectiveRuntimeBudget(resolveHarnessConfig({ unlimitedTokens: false }).budget)).toHaveProperty("maxInputTokens", 100000);
  expect(() => resolveHarnessConfig({ unlimitedTokens: "true" as any })).toThrow("boolean");
});

for (const provider of ["meta", "openai", "qwen"] as const) {
  test(`${provider}: unlimited run crosses every cumulative ceiling and resumes approval with usage intact`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unlimited-budget-"));
    const changes = [{ path: "created.txt", expectedDigest: null, content: "approved" }];
    const proposal = createEditProposal({ changes });
    const caps: (number | undefined)[] = [];
    const model = createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "edit", name: "apply_patch", input: { proposalId: proposal.proposalId, changes } } },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 200000, outputTokens: 40000, totalTokens: 240000 } }],
      [{ type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 200000, outputTokens: 40000, totalTokens: 240000 } }]
    ] });
    const stream = model.stream!;
    model.stream = input => { caps.push(input.maxTokens); return stream(input); };
    const harness = await createHarness({ workspace: root, provider, modelInstance: model,
      store: createInMemoryAgentRunStore(), subagentProfiles: [], unlimitedTokens: true });
    try {
      const waiting = await runHarness(harness, { prompt: "Create then finish.", maxTokens: 50000, scope: harness.config.scope });
      expect(waiting.status).toBe("waiting_approval");
      const result = await runHarness(harness, { state: waiting.state, maxTokens: 50000,
        approvals: waiting.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
      expect(result.status).toBe("completed");
      expect(result.usage?.inputTokens).toBe(400000);
      expect(result.usage?.outputTokens).toBe(80000);
      expect(caps).toEqual([50000, 50000]);
      const inspection = await inspectHarnessRun(harness.store, harness.config, result.state.runId);
      expect(inspection.budget.remaining.inputTokens).toBeUndefined();
      expect(inspection.budget.remaining.outputTokens).toBeUndefined();
      expect(inspection.budget.remaining.totalTokens).toBeUndefined();
      expect(inspection.budget.consumption.inputTokens).toBe(400000);
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("unlimited repair budgets retain finite serializable accounting and per-request caps", async () => {
  const limits = { inputTokens: Infinity, outputTokens: Infinity };
  const budget = createModelBudget(limits);
  budget.stats.inputTokens = 10000000; budget.stats.outputTokens = 10000000;
  const context = { input: { messages: [], maxTokens: 1234 }, model: createMockLanguageModel() };
  expect(workBudgetReached(context.input, budget.stats, limits)).toBe(false);
  expect(createRepairProgress(() => budget.stats, limits).closing()).toBe(false);
  await budget.middleware.wrapGenerate!(context, async () => ({ usage: { inputTokens: 10, outputTokens: 1 } }));
  expect(context.input.maxTokens).toBe(1234);
  expect(budget.stats.reservedInputTokens).toBe(0);
  expect(budget.stats.reservedOutputTokens).toBe(0);
  expect(JSON.parse(JSON.stringify(budget.stats))).toEqual(budget.stats);
  const restored = createModelBudget(limits, { saved: JSON.parse(JSON.stringify(budget.snapshot())) });
  expect(restored.stats.inputTokens).toBe(10000010);
});

for (const requireVerifiedDelivery of [false, true]) {
  test(`verified delivery=${requireVerifiedDelivery}: unlimited mode preserves its completion contract with orchestration`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unlimited-orchestration-"));
    const model = createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "list", name: "list_files", input: {} } },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 200000, outputTokens: 1000, totalTokens: 201000 } }],
      [{ type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 200000, outputTokens: 1000, totalTokens: 201000 } }],
      [{ type: "text-delta", textDelta: "still no verified patch" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 200000, outputTokens: 1000, totalTokens: 201000 } }]
    ] });
    const harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model,
      store: createInMemoryAgentRunStore(), subagentProfiles: ["explorer"], requireVerifiedDelivery,
      unlimitedTokens: true, maxInputTokens: 1, maxOutputTokens: 1, maxTotalTokens: 2 });
    try {
      const result = await runHarness(harness, { prompt: "List the files then finish.", maxTokens: 2048 });
      expect(result.status).toBe(requireVerifiedDelivery ? "failed" : "completed");
      expect(result.usage?.inputTokens).toBe(requireVerifiedDelivery ? 600000 : 400000);
      if (requireVerifiedDelivery) expect(result.state.error?.message).toBe("REPAIR_INCOMPLETE");
    } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
  });
}
