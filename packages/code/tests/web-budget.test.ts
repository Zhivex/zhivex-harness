import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHarness, resolveHarnessConfig, runHarness } from "@zhivex-ai/harness/engine";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { interactiveBudgetOptions, consoleBudgetOptions } from "../src/cli/console/console-budget.js";

test("Web removes only approved accumulated caps and retains its original tool-error guard", () => {
  const web = interactiveBudgetOptions({}, {});
  expect(web).not.toHaveProperty("maxToolErrors");
  const actual = resolveHarnessConfig(web).budget;
  expect(actual.maxToolErrors).toBe(resolveHarnessConfig({}).budget.maxToolErrors);
  expect(actual.unlimitedSteps).toBe(true);
  expect(actual.unlimitedToolCalls).toBe(true);
  expect(actual.unlimitedTokens).toBe(true);
  expect(resolveHarnessConfig(web).unlimitedDuration).toBe(true);
  expect(resolveHarnessConfig(interactiveBudgetOptions({ maxToolErrors: 1 }, {})).budget.maxToolErrors).toBe(1);
  expect(interactiveBudgetOptions({}, { ZHIVEX_HARNESS_MAX_TOOL_ERRORS: "2" })).not.toHaveProperty("maxToolErrors");
  expect(consoleBudgetOptions({}, {}).maxToolErrors).toBe(20);
});

test("real unbounded Web execution retains and enforces the existing maxToolErrors 4 policy", async () => {
  const workspace = await mkdtemp("/tmp/web-error-guard-");
  const model = createMockLanguageModel({ streamEvents: Array.from({ length: 5 }, (_, index) => [
    { type: "tool-call" as const, toolCall: { id: `missing-${index}`, name: "read_file", input: { path: `missing-${index}.txt` } } },
    { type: "finish" as const, finishReason: "tool-calls" as const },
  ]) });
  let failedTools = 0;
  const harness = await createHarness({ ...interactiveBudgetOptions({}, {}), workspace, modelInstance: model,
    provider: "openai", store: createInMemoryAgentRunStore(), subagentProfiles: [] });
  try {
    expect(harness.agent.maxSteps).toBe("unlimited");
    expect(harness.config.budget.maxToolErrors).toBe(4);
    await expect(runHarness(harness, { prompt: "Try missing files" }, { onEvent: event => {
      if (event.type === "tool-result" && event.toolResult.isError) failedTools++;
    } })).rejects.toThrow("maxToolErrors");
    // Preserve the SDK's existing receipt-based violation semantics.
    expect(failedTools).toBe(5);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
