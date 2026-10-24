import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHarness, resolveHarnessConfig, runHarness } from "@zhivex-ai/harness/engine";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { consoleBudgetOptions, interactiveBudgetOptions, webBudgetOptions } from "../src/cli/console/console-budget.js";

test("Web keeps finite ceilings for tools, tokens, steps and time, and retains the tool-error guard", () => {
  const web = webBudgetOptions({}, {});
  expect(web.unlimitedToolCalls).toBe(false);
  expect(web.unlimitedTokens).toBe(false);
  expect(web.unlimitedSteps).toBe(false);
  expect(web.unlimitedDuration).toBe(false);
  const actual = resolveHarnessConfig(web).budget;
  expect(actual.maxToolCalls).toBe(32);
  expect(actual.maxTotalTokens).toBe(120_000);
  expect(actual.maxToolErrors).toBe(resolveHarnessConfig({}).budget.maxToolErrors);
  expect(actual.unlimitedToolCalls).toBe(false);
  expect(resolveHarnessConfig(web).unlimitedDuration).toBe(false);
  expect(resolveHarnessConfig(webBudgetOptions({ maxToolCalls: 4 }, {})).budget.maxToolCalls).toBe(4);
  expect(interactiveBudgetOptions({}, {}).unlimitedToolCalls).toBe(true);
  expect(consoleBudgetOptions({}, {}).maxToolErrors).toBe(20);
});

test("Web still enforces the existing maxToolErrors 4 policy on read-only tools", async () => {
  const workspace = await mkdtemp("/tmp/web-error-guard-");
  const model = createMockLanguageModel({ streamEvents: Array.from({ length: 5 }, (_, index) => [
    { type: "tool-call" as const, toolCall: { id: `missing-${index}`, name: "read_file", input: { path: `missing-${index}.txt` } } },
    { type: "finish" as const, finishReason: "tool-calls" as const },
  ]) });
  let failedTools = 0;
  const harness = await createHarness({ ...webBudgetOptions({}, {}), workspace, modelInstance: model,
    provider: "openai", store: createInMemoryAgentRunStore(), subagentProfiles: [] });
  try {
    expect(harness.agent.maxSteps).toBe(50);
    expect(harness.config.budget.maxToolErrors).toBe(4);
    await expect(runHarness(harness, { prompt: "Try missing files" }, { onEvent: event => {
      if (event.type === "tool-result" && event.toolResult.isError) failedTools++;
    } })).rejects.toThrow("maxToolErrors");
    // Preserve the SDK's existing receipt-based violation semantics.
    expect(failedTools).toBe(5);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
