import type { AgentRunOutput, AgentRunState, AgentStoreScope } from "@zhivex-ai/core";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";

/** Capture the winning source before relaying its abort. Nested AbortSignal.any
 * trees can propagate a different ancestor's reason on supported Node versions. */
export const composeRunInterruption = (caller: AbortSignal | undefined,
  deadline: AbortSignal | undefined, failure: AbortSignal) => {
  const controller = new AbortController();
  let winner: 'cancelled' | 'timed_out' | undefined;
  const cleanups: Array<() => void> = [];
  const dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  for (const [signal, kind] of [[caller, 'cancelled'], [deadline, 'timed_out'], [failure, undefined]] as const) {
    if (!signal || controller.signal.aborted) continue;
    const abort = () => {
      if (controller.signal.aborted) return;
      winner = kind;
      controller.abort(signal.reason);
      dispose();
    };
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', abort));
    }
  }
  return { signal: controller.signal, kind: () => winner, dispose };
};

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
