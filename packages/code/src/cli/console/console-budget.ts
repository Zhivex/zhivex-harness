import type { CliOptions } from "../arguments.js";
import { type HarnessConfig, type HarnessConfigInput } from "@zhivex-ai/harness/engine";
import type { TokenUsage } from "@zhivex-ai/core";

const tokenOptions = ["maxInputTokens", "maxOutputTokens", "maxTotalTokens",
  "subagentMaxInputTokens", "subagentMaxOutputTokens", "subagentMaxTotalTokens"] as const;
const tokenEnvironment = ["ZHIVEX_HARNESS_MAX_INPUT_TOKENS", "ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS",
  "ZHIVEX_HARNESS_MAX_TOTAL_TOKENS", "ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS",
  "ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS", "ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS"] as const;

/** Only new local console sessions change defaults. Explicit limits always opt
 * into bounded execution; SDK, service hosts and automation retain their policy. */
export const consoleBudgetOptions = <T extends HarnessConfigInput>(options: T, env: NodeJS.ProcessEnv = process.env) => ({
  ...options,
  ...(options.maxToolErrors === undefined && env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS === undefined ? { maxToolErrors: 20 } : {}),
  unlimitedSteps: options.unlimitedSteps ?? (options.maxSteps === undefined && env.ZHIVEX_HARNESS_MAX_STEPS === undefined),
  unlimitedToolCalls: options.unlimitedToolCalls ?? (options.maxToolCalls === undefined && env.ZHIVEX_HARNESS_MAX_TOOL_CALLS === undefined),
  unlimitedDuration: options.unlimitedDuration ?? (options.timeoutMs === undefined && env.ZHIVEX_HARNESS_TIMEOUT_MS === undefined),
  unlimitedTokens: options.unlimitedTokens ??
    !(tokenOptions.some(key => options[key] !== undefined) || tokenEnvironment.some(key => env[key] !== undefined))
});

/** A saved run owns its budget, including legacy runs without a mode flag. */
export const restoreConsoleOptions = (current: CliOptions, saved: Partial<CliOptions>): CliOptions => ({
  ...current, ...saved, reasoningEffort: saved.reasoningEffort ?? "default", unlimitedTokens: saved.unlimitedTokens ?? false,
  unlimitedSteps: saved.unlimitedSteps ?? false, unlimitedToolCalls: saved.unlimitedToolCalls ?? false, unlimitedDuration: saved.unlimitedDuration ?? false
});

export const formatConsoleBudget = (config: HarnessConfig, usage?: TokenUsage) => {
  const lines = [`Step limit: ${config.budget.unlimitedSteps ? "none" : config.maxSteps} model iterations per turn.`, config.budget.unlimitedTokens
    ? "Cumulative token budget per run: unlimited; operation, model, state and safety controls still apply."
    : `Cumulative token limits per run: input ${config.budget.maxInputTokens}; output ${config.budget.maxOutputTokens}; total ${config.budget.maxTotalTokens}.`];
  lines.push(`Tool limits: ${config.budget.unlimitedToolCalls ? "no cumulative cap on" : config.budget.maxToolCalls} calls / ${config.budget.maxToolErrors} errors; time: ${config.unlimitedDuration ? "no cumulative deadline" : `${Math.round(config.timeoutMs / 60000)} minutes per run`}.`);
  if (config.costBudget) lines.push(`Legacy measured-cost limit: $${config.costBudget.maxCostUsd} per run (estimate, not an invoice or guaranteed financial cap).`);
  if (!usage) return [...lines, "Latest run usage: unavailable."].join("\n");
  const input = usage.inputTokens, output = usage.outputTokens;
  const total = usage.totalTokens ?? (input !== undefined && output !== undefined ? input + output : undefined);
  lines.push(`Latest run cumulative usage: input ${input ?? "unknown"}; output ${output ?? "unknown"}; total ${total ?? "unknown"}.`);
  if (!config.budget.unlimitedTokens) {
    const remaining = (limit: number, value: number | undefined) => value === undefined ? "unknown" : Math.max(0, limit - value);
    lines.push(`Latest run remaining: input ${remaining(config.budget.maxInputTokens, input)}; output ${remaining(config.budget.maxOutputTokens, output)}; total ${remaining(config.budget.maxTotalTokens, total)}.`);
  }
  return lines.join("\n");
};
