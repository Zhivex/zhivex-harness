import type { AgentRunOutput, AgentRunState, AgentStoreScope } from "@zhivex-ai/core";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";

/** Called only after the interrupted runtime has settled and released its lease. */
export const settleInterruptedRun = async (
  store: AgentRunStore, runId: string, scope?: AgentStoreScope,
  kind: 'cancelled' | 'timed_out' = 'cancelled'
): Promise<AgentRunOutput | undefined> => {
  const previous = await store.load(runId, scope);
  // Never overwrite successful work, a real timeout, or an unresolved approval.
  if (!previous || (previous.status !== "failed" && !(kind === "cancelled" && previous.status === "cancel_requested"))) return undefined;
  const { error: _error, cancelledAt: _cancelledAt, cancellationReason: _reason, ...rest } = previous;
  const now = Date.now();
  const revision = previous.revision ?? 0;
  const state: AgentRunState = { ...rest, status: kind,
    ...(kind === 'cancelled' ? { cancelledAt: now, cancellationReason: "Interrupted by the caller." }
      : { error: { message: 'Run exceeded its time limit.' } }), updatedAt: now,
    revision: revision + 1 };
  await store.save(state, { expectedRevision: revision });
  return { status: state.status, outputText: state.outputText, messages: state.messages,
    steps: state.steps, toolResults: state.toolResults, state,
    ...(state.error ? { error: state.error } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.finishReason ? { finishReason: state.finishReason } : {}) };
};
