import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { consoleBudgetOptions, restoreConsoleOptions } from "../src/cli/console/console-budget.js";
import { createHarnessResumeMetadata, readHarnessResumeConfig } from "../src/cli/resume-metadata.js";
import { effectiveRuntimeBudget, runtimeManifest } from "../src/runtime/runtime-policy.js";
import { inspectRuntimeManifest } from "../src/runtime/runtime-diagnostics.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { cliRunEventDocumentSchema } from "../src/client/json-contracts.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { interactiveBudgetOptions, consoleBudgetOptions as codeConsoleOptions } from "../packages/code/src/cli/console/console-budget.js";

test("Web removes only approved accumulated caps and retains its original tool-error guard", () => {
  const web = interactiveBudgetOptions({}, {});
  expect(web).not.toHaveProperty("maxToolErrors");
  expect(effectiveRuntimeBudget(resolveHarnessConfig(web).budget)).toEqual({ maxToolErrors: resolveHarnessConfig({}).budget.maxToolErrors, includeChildRuns: true });
  expect(resolveHarnessConfig(interactiveBudgetOptions({ maxToolErrors: 1 }, {})).budget.maxToolErrors).toBe(1);
  expect(interactiveBudgetOptions({}, { ZHIVEX_HARNESS_MAX_TOOL_ERRORS: "2" })).not.toHaveProperty("maxToolErrors");
  expect(codeConsoleOptions({}, {}).maxToolErrors).toBe(20);
});

test("interactive defaults omit accumulated ceilings, preserve explicit/environment settings and stored numeric values", () => {
  const config = resolveHarnessConfig(consoleBudgetOptions({}, {}));
  expect(effectiveRuntimeBudget(config.budget)).toEqual({ maxToolErrors: 20, includeChildRuns: true });
  expect(config.maxSteps).toBe(50); expect(config.timeoutMs).toBe(900000);
  expect(config.unlimitedDuration).toBe(true);
  const saved = readHarnessResumeConfig({ metadata: JSON.parse(JSON.stringify(createHarnessResumeMetadata(config))) });
  expect(resolveHarnessConfig(saved)).toEqual(config);
  expect(inspectRuntimeManifest(runtimeManifest(config, []))?.unlimitedDuration).toBe(true);
  expect(inspectRuntimeManifest(runtimeManifest(config, []))?.budget.unlimitedSteps).toBe(true);
  for (const [field, env] of [["maxSteps", "ZHIVEX_HARNESS_MAX_STEPS"], ["maxToolCalls", "ZHIVEX_HARNESS_MAX_TOOL_CALLS"], ["timeoutMs", "ZHIVEX_HARNESS_TIMEOUT_MS"]] as const) {
    const flag = field === "maxSteps" ? "unlimitedSteps" : field === "maxToolCalls" ? "unlimitedToolCalls" : "unlimitedDuration";
    expect(consoleBudgetOptions({ [field]: 5000 }, {})[flag]).toBe(false);
    expect(consoleBudgetOptions({}, { [env]: "5000" })[flag]).toBe(false);
  }
  expect(consoleBudgetOptions({ maxCostUsd: 1, inputCostPerMillion: 2 }, {}).maxCostUsd).toBe(1);
  const legacy = restoreConsoleOptions(consoleBudgetOptions(parseCliArgs(["chat"]), {}), parseCliArgs(["chat", "--max-steps", "50", "--max-tool-calls", "32", "--timeout-ms", "900000"]));
  expect(legacy.unlimitedSteps).toBe(false); expect(legacy.unlimitedToolCalls).toBe(false); expect(legacy.unlimitedDuration).toBe(false);
  for (const key of ["unlimitedSteps", "unlimitedToolCalls", "unlimitedDuration"] as const)
    expect(() => resolveHarnessConfig({ [key]: "yes" })).toThrow("boolean");
  expect(effectiveRuntimeBudget(resolveHarnessConfig({}).budget)).toHaveProperty("maxSteps", 50);
});

test("real SDK runs exceed inactive stored steps/tools/tokens/deadline and retain per-request caps", async () => {
  const workspace = await mkdtemp("/tmp/interactive-limits-");
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "read", name: "list_files", input: {} } }, { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } }],
    [{ type: "tool-call", toolCall: { id: "read2", name: "list_files", input: {} } }, { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } }],
    [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }],
  ] });
  const caps: (number | undefined)[] = [], deadlines: (number | undefined)[] = [];
  const stream = model.stream!;
  model.stream = async input => { caps.push(input.maxTokens); deadlines.push(input.timeoutMs);
    if (caps.length === 1) await new Promise(resolve => setTimeout(resolve, 1100)); return stream(input); };
  const harness = await createHarness({ workspace, modelInstance: model, provider: "openai", store: createInMemoryAgentRunStore(), subagentProfiles: [],
    maxSteps: 1, maxToolCalls: 0, maxInputTokens: 1, maxOutputTokens: 1, maxTotalTokens: 2, timeoutMs: 1000,
    unlimitedTokens: true, unlimitedSteps: true, unlimitedToolCalls: true, unlimitedDuration: true });
  try {
    expect(harness.agent.maxSteps).toBe("unlimited"); expect(harness.agent.policy).not.toHaveProperty("timeoutMs");
    expect(harness.agent.policy?.maxStateBytes).toBe(4194304); expect(harness.agent.policy?.leaseMode).toBe("required");
    const result = await runHarness(harness, { prompt: "List twice then finish", maxTokens: 123, timeoutMs: 5000 }, {
      onEvent: event => { if (event.type === "agent-run-start") expect(cliRunEventDocumentSchema.safeParse({ schemaVersion: 1, sequence: 0, kind: "run-event", type: event.type, runId: "run_fixture", provider: "openai", model: "fixture", currentStep: event.currentStep, maxSteps: event.maxSteps }).success).toBe(true); },
    });
    expect(result.status).toBe("completed"); expect(result.state.maxSteps).toBe("unlimited");
    expect(result.state.steps).toHaveLength(3); expect(result.state.toolResults).toHaveLength(2);
    expect(caps).toEqual([123, 123, 123]); expect(deadlines).toEqual([5000, 5000, 5000]);
    expect(JSON.parse(JSON.stringify(result.state)).maxSteps).toBe("unlimited");
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
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
    // The existing SDK guard reports the violation after the fifth error receipt;
    // preserving this policy does not change its observation/enforcement semantics.
    expect(failedTools).toBe(5);
  } finally { await harness.close(); await rm(workspace, { recursive: true, force: true }); }
});
