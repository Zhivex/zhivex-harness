import type {
  AgentRunOutput,
  ToolDefinition,
  ToolSet
} from "@zhivex-ai/agents";

import type { TimeToSafeFixDriverResult } from "../src/time-to-safe-fix.js";

export type TimeToSafeFixEfficiency = NonNullable<TimeToSafeFixDriverResult["efficiency"]>;
export type TimeToSafeFixApprovalRound = TimeToSafeFixEfficiency["approvalRounds"][number];

interface MutableToolTiming {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export const selectAndInstrumentTools = (
  available: ToolSet,
  names: readonly string[]
) => {
  const timings = new Map<string, MutableToolTiming>();
  const selected: ToolSet = {};
  for (const name of names) {
    const definition = available[name];
    if (!definition || !("execute" in definition)) {
      throw new Error(`Required benchmark tool ${name} is unavailable or not locally callable.`);
    }
    const callable = definition as ToolDefinition;
    selected[name] = {
      ...callable,
      async execute(input, context) {
        const startedAt = performance.now();
        const timing = timings.get(name) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
        timing.calls += 1;
        timings.set(name, timing);
        try {
          return await callable.execute(input, context);
        } catch (error) {
          timing.errors += 1;
          throw error;
        } finally {
          const durationMs = performance.now() - startedAt;
          timing.totalMs += durationMs;
          timing.maxMs = Math.max(timing.maxMs, durationMs);
        }
      }
    };
  }
  return { tools: selected, timings };
};

const toolCallsInMessages = (messages: AgentRunOutput["messages"]) => messages.reduce(
  (total, message) => total + message.parts.filter((part) => part.type === "tool-call").length,
  0
);

export const buildTimeToSafeFixEfficiency = (
  output: AgentRunOutput | undefined,
  activeToolDefinitions: number,
  approvalRounds: readonly TimeToSafeFixApprovalRound[],
  timings: ReadonlyMap<string, MutableToolTiming>
): TimeToSafeFixEfficiency => {
  const turns = (output?.steps ?? []).map((step) => {
    const inputTokens = step.response?.usage?.inputTokens ?? 0;
    return {
      index: step.index,
      status: step.status,
      durationMs: Math.max(0, (step.finishedAt ?? step.startedAt ?? 0) - (step.startedAt ?? step.finishedAt ?? 0)),
      requestMessages: (step.request.messageOffset ?? 0) + step.request.messages.length,
      inputTokens,
      cachedInputTokens: step.response?.usage?.cachedInputTokens ?? 0,
      outputTokens: step.response?.usage?.outputTokens ?? 0,
      toolCalls: toolCallsInMessages(step.response?.messages ?? [])
    };
  });
  return {
    activeToolDefinitions,
    modelTurns: turns.length,
    compactions: output?.state.compactions?.length ?? 0,
    peakInputTokensPerTurn: Math.max(0, ...turns.map((turn) => turn.inputTokens)),
    peakRequestMessages: Math.max(0, ...turns.map((turn) => turn.requestMessages)),
    turns,
    approvalRounds: [...approvalRounds],
    tools: [...timings.entries()]
      .map(([name, timing]) => ({ name, ...timing }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
};
