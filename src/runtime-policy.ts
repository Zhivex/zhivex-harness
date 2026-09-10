import { createBudgetGuard, createProductionSafetyPolicy } from "@zhivex-ai/agents";
import type { HarnessConfig } from "./config.js";

/** Main runs and children use identical durable guards. Token transport controls
 * remain separate for providers that cannot accept maxTokens. */
export const createRuntimeBudget = (budget: HarnessConfig["budget"], transportTokens: boolean) => {
  const durable = createBudgetGuard(budget);
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
