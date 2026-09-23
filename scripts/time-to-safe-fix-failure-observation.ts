import type { AgentRunState } from "@zhivex-ai/core";

export interface TimeToSafeFixFailureObservation {
  source: "persisted" | "unavailable";
  status?: AgentRunState["status"];
  /** Reported totals on interrupted runs are lower bounds, not complete billing. */
  usage: "reported" | "partial" | "unavailable";
  modelTurns?: number;
  compactions?: number;
  toolResults?: number;
  toolErrors?: number;
  currentStep?: number;
  maxSteps?: number;
}

export interface TimeToSafeFixRecoveredMetrics {
  observation: TimeToSafeFixFailureObservation;
  promptTokens?: number;
  completionTokens?: number;
  /** Retains the benchmark's historical completed-tool-result count semantics. */
  toolCalls?: number;
}

const tokenCount = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Project only structural counters from the durable state. Never export messages,
 * arguments, results, identifiers, metadata, error text, or compaction summaries.
 * Do not rebuild usage from retained messages: compaction can remove history and
 * a provider failure may happen before its token receipt is persisted.
 */
export const observeTimeToSafeFixFailureState = (
  state: AgentRunState | undefined
): TimeToSafeFixRecoveredMetrics => {
  if (!state) return { observation: { source: "unavailable", usage: "unavailable" } };

  const promptTokens = tokenCount(state.usage?.inputTokens);
  const completionTokens = tokenCount(state.usage?.outputTokens);
  const hasUsage = promptTokens !== undefined || completionTokens !== undefined;
  const allTurnsReported = state.steps.every((step) =>
    tokenCount(step.response?.usage?.inputTokens) !== undefined &&
    tokenCount(step.response?.usage?.outputTokens) !== undefined
  );
  return {
    observation: {
      source: "persisted",
      status: state.status,
      usage: !hasUsage ? "unavailable" :
        state.status === "completed" && promptTokens !== undefined &&
        completionTokens !== undefined && allTurnsReported ? "reported" : "partial",
      modelTurns: state.steps.length,
      compactions: state.compactions?.length ?? 0,
      toolResults: state.toolResults.length,
      toolErrors: state.toolResults.filter((result) => result.isError).length,
      currentStep: state.currentStep,
      maxSteps: state.maxSteps
    },
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    toolCalls: state.toolResults.length
  };
};
