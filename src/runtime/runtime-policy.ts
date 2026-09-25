import type { LanguageModelMiddleware, ModelGenerateInput, TokenUsage } from "@zhivex-ai/core";
import { createBudgetGuard, createProductionSafetyPolicy } from "@zhivex-ai/agents";
import { estimateRequestTokens } from "./model-budget.js";
import type { HarnessConfig } from "./config.js";

/** Project stored settings into the active SDK policy without inactive ceilings. */
export const effectiveRuntimeBudget = (budget: HarnessConfig["budget"]) => {
  const { unlimitedTokens, maxInputTokens, maxOutputTokens, maxTotalTokens, ...nonTokenBudget } = budget;
  return unlimitedTokens ? nonTokenBudget : { ...nonTokenBudget, maxInputTokens, maxOutputTokens, maxTotalTokens };
};

/** Main runs and children use identical durable guards. Token transport controls
 * remain separate for providers that cannot accept maxTokens. */
export const createRuntimeBudget = (budget: HarnessConfig["budget"], transportTokens: boolean) => {
  const durable = createBudgetGuard(effectiveRuntimeBudget(budget));
  const transport = transportTokens ? durable : createBudgetGuard({ maxSteps: budget.maxSteps,
    maxToolCalls: budget.maxToolCalls, maxToolErrors: budget.maxToolErrors, includeChildRuns: budget.includeChildRuns });
  return { ...transport, inputGuardrail: durable.inputGuardrail, outputGuardrail: durable.outputGuardrail };
};
export const runtimeManifest = (config: HarnessConfig, tools: readonly string[], role = "primary") => ({
  schemaVersion: 1, policyVersion: "repair-v2-durable-closure", role, profile: config.agentProfile,
  backend: config.execution.backend, tools: [...tools].sort(),
  budget: { ...(role === "primary" ? config.budget : config.orchestration.childBudget) },
  timeoutMs: role === "primary" ? config.timeoutMs : config.orchestration.childTimeoutMs,
  closureController: role === "primary" && config.agentProfile === "repair",
  contextEnabled: config.context.enabled
});
export const childRuntimeSafety = (config: HarnessConfig) => createProductionSafetyPolicy({
  budget: createRuntimeBudget(config.orchestration.childBudget, false),
  toolExecution: { parallel: false, stopOnError: config.agentProfile !== "repair",
    ...(config.agentProfile === "repair" ? { validationErrorMode: "tool-result" as const } : {}) }
});

/** Cap each request against observed usage and the persisted checkpoint, including
 * resumed runs and compaction usage. SDK 1.20 computes its own transport ceiling only once per
 * invocation; retaining that ceiling in preflight rejects valid second turns.
 * Durable input/output guards remain responsible for actual reported usage.
 */
export const createCheckpointTokenCap = (
  limits: HarnessConfig["budget"],
  usage: () => Promise<TokenUsage | undefined>,
  transportTokens = true,
  options: { initialUsage?: TokenUsage; closeOnBudget?: boolean; additionalUsage?: () => Promise<TokenUsage> } = {}
): LanguageModelMiddleware & { observed: TokenUsage; auxiliary(): LanguageModelMiddleware } => {
  const observed = { inputTokens: options.initialUsage?.inputTokens ?? 0,
    outputTokens: options.initialUsage?.outputTokens ?? 0,
    totalTokens: options.initialUsage?.totalTokens ?? ((options.initialUsage?.inputTokens ?? 0) + (options.initialUsage?.outputTokens ?? 0)) };
  const cap = async (input: ModelGenerateInput, auxiliary = false) => {
    if (limits.unlimitedTokens) return;
    const persisted = await usage();
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const value = persisted?.[key] ?? (key === "totalTokens" ? (persisted?.inputTokens ?? 0) + (persisted?.outputTokens ?? 0) : 0);
      observed[key] = Math.max(observed[key], value);
    }
    const additional = await options.additionalUsage?.();
    const remainingOutput = limits.maxOutputTokens - observed.outputTokens - (additional?.outputTokens ?? 0);
    const remainingInput = limits.maxInputTokens - observed.inputTokens - (additional?.inputTokens ?? 0);
    const remainingTotal = limits.maxTotalTokens - observed.totalTokens - (additional?.totalTokens ?? 0);
    if (remainingInput <= 0) throw new Error("maxInputTokens budget exhausted");
    if (remainingOutput <= 0) throw new Error("maxOutputTokens budget exhausted");
    if (remainingTotal <= 0) throw new Error("maxTotalTokens budget exhausted");
    let predicted = estimateRequestTokens(input);
    // Reserve the last 30% for an evidence-based answer, with no new tool work.
    if (!auxiliary && options.closeOnBudget && (observed.inputTokens + predicted > limits.maxInputTokens * 0.7 ||
        observed.outputTokens >= limits.maxOutputTokens * 0.7 ||
        observed.totalTokens + predicted > limits.maxTotalTokens * 0.7)) {
      delete input.tools;
      delete input.toolChoice;
      input.messages = [...input.messages, { role: "system", parts: [{ type: "text",
        text: "The run is approaching its cumulative token budget. Finish now using only the evidence already collected. State what was established and what remains unverified; do not claim that unfinished work is complete. No further tools are available." }] }];
      predicted = estimateRequestTokens(input);
    }
    if (predicted > remainingInput) throw new Error("maxInputTokens budget exhausted");
    if (predicted >= remainingTotal) throw new Error("maxTotalTokens budget exhausted");
    if (transportTokens || auxiliary) input.maxTokens = Math.min(input.maxTokens ?? remainingOutput, remainingOutput, remainingTotal - predicted);
  };
  const record = (reported: TokenUsage | undefined, enforce = true) => {
    observed.inputTokens += reported?.inputTokens ?? 0;
    observed.outputTokens += reported?.outputTokens ?? 0;
    const sum = (reported?.inputTokens ?? 0) + (reported?.outputTokens ?? 0);
    observed.totalTokens += Number.isSafeInteger(reported?.totalTokens) && reported!.totalTokens! >= 0
      ? Math.max(reported!.totalTokens!, sum) : sum;
    if (limits.unlimitedTokens || !enforce) return;
    // Reject an over-budget response before the SDK can execute its tools.
    if (observed.inputTokens > limits.maxInputTokens) throw new Error("maxInputTokens budget exceeded");
    if (observed.outputTokens > limits.maxOutputTokens) throw new Error("maxOutputTokens budget exceeded");
    if (observed.totalTokens > limits.maxTotalTokens) throw new Error("maxTotalTokens budget exceeded");
  };
  return {
    name: "harness-checkpoint-token-cap",
    observed,
    auxiliary: () => ({ name: "harness-utility-token-cap", async wrapGenerate(context, next) {
      // The SDK must receive the receipt before rejecting a paid compaction.
      await cap(context.input, true); const result = await next(); record(result.usage, false); return result;
    } }),
    async wrapGenerate(context, next) {
      await cap(context.input); const result = await next(); record(result.usage); return result;
    },
    async wrapStream(context, next) {
      await cap(context.input); const stream = await next();
      return (async function* () {
        let recorded = false;
        for await (const event of stream) {
          if (event.type === "finish" && !recorded) { record(event.usage); recorded = true; }
          yield event;
        }
      })();
    }
  };
};
