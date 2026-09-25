import { expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/arguments.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { consoleBudgetOptions, restoreConsoleOptions, formatConsoleBudget } from "../src/cli/console/console-budget.js";
import { createHarnessResumeMetadata, readHarnessResumeConfig, persistedCliOptions } from "../src/cli/resume-metadata.js";

test("new consoles continue without token ceilings while automation remains bounded", () => {
  const options = parseCliArgs(["chat"]);
  const config = resolveHarnessConfig(consoleBudgetOptions(options, {}));
  expect(config.budget.unlimitedTokens).toBe(true);
  expect(config.orchestration.childBudget.unlimitedTokens).toBe(true);
  expect(config.budget.maxSteps).toBe(50);
  expect(config.compaction.maxEstimatedInputTokens).toBe(40000);
  expect(resolveHarnessConfig(parseCliArgs(["run", "task"])).budget.unlimitedTokens).not.toBe(true);
  expect(resolveHarnessConfig(parseCliArgs(["review", "task"])).budget.unlimitedTokens).not.toBe(true);
  expect(resolveHarnessConfig({}).budget.unlimitedTokens).not.toBe(true);
});

test("explicit policies and environment limits override the interactive default", () => {
  for (const args of [["--token-budget"], ["--max-input-tokens", "200000", "--max-total-tokens", "230000"],
    ["--subagent-max-input-tokens", "10000"]]) {
    expect(consoleBudgetOptions(parseCliArgs(["chat", ...args]), {}).unlimitedTokens).toBe(false);
  }
  expect(consoleBudgetOptions(parseCliArgs(["chat"]), { ZHIVEX_HARNESS_MAX_INPUT_TOKENS: "200000" }).unlimitedTokens).toBe(false);
  expect(consoleBudgetOptions(parseCliArgs(["chat", "--no-token-budget"]),
    { ZHIVEX_HARNESS_MAX_INPUT_TOKENS: "200000" }).unlimitedTokens).toBe(true);
  expect(() => parseCliArgs(["chat", "--token-budget", "--no-token-budget"])).toThrow();
});

test("context threshold is independent of the cumulative policy and survives resume", () => {
  const config = resolveHarnessConfig(consoleBudgetOptions(parseCliArgs(["chat", "--context-tokens", "100000"]), {}));
  expect(config.budget.unlimitedTokens).toBe(true);
  expect(config.compaction.maxEstimatedInputTokens).toBe(100000);
  const saved = persistedCliOptions(readHarnessResumeConfig({ metadata: createHarnessResumeMetadata(config) }));
  const restored = restoreConsoleOptions(parseCliArgs(["chat", "--token-budget"]), saved);
  expect(restored.unlimitedTokens).toBe(true);
  expect(resolveHarnessConfig(restored).compaction.maxEstimatedInputTokens).toBe(100000);
  expect(() => resolveHarnessConfig(parseCliArgs(["chat", "--context-tokens", "0"]))).toThrow();
});

test("legacy saved limits never inherit an unlimited console default", () => {
  const current = consoleBudgetOptions(parseCliArgs(["chat"]), {});
  const legacy = persistedCliOptions(readHarnessResumeConfig({ metadata: createHarnessResumeMetadata(resolveHarnessConfig({})) }));
  expect(restoreConsoleOptions(current, legacy).unlimitedTokens).toBe(false);
  expect(restoreConsoleOptions(current, { unlimitedTokens: false }).unlimitedTokens).toBe(false);
});

test("usage display separates cumulative consumption and remaining budget without inventing unknown usage", () => {
  expect(formatConsoleBudget(resolveHarnessConfig({ unlimitedTokens: true }), { inputTokens: 250000, outputTokens: 5000 }))
    .toContain("Cumulative token budget: unlimited");
  const bounded = formatConsoleBudget(resolveHarnessConfig({}), { inputTokens: 87526, outputTokens: 1356 });
  expect(bounded).toContain("total 88882");
  expect(bounded).toContain("remaining: input 12474");
  expect(formatConsoleBudget(resolveHarnessConfig({}), { outputTokens: 5 })).toContain("input unknown");
  expect(formatConsoleBudget(resolveHarnessConfig({}))).toContain("usage: unavailable");
});


test("console step policy respects flags, environment, and saved run limits", () => {
  expect(consoleBudgetOptions(parseCliArgs(["chat","--max-steps","20"]),{}).maxSteps).toBe(20);
  expect(consoleBudgetOptions(parseCliArgs(["chat"]),{ZHIVEX_HARNESS_MAX_STEPS:"15"}).maxSteps).toBeUndefined();
  expect(restoreConsoleOptions(consoleBudgetOptions(parseCliArgs(["chat"]),{}),{maxSteps:12}).maxSteps).toBe(12);
  expect(resolveHarnessConfig(parseCliArgs(["run","task"])).maxSteps).toBe(12);
});
