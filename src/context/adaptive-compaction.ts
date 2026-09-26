import type { AgentCompactionOptions, ModelMessage, ToolSet } from "@zhivex-ai/core";
import { COMPACTION_STRATEGY, summarizeHarnessMessages } from "./compaction.js";
import { estimateContextTokens, measureContext } from "./context-metrics.js";

export const estimateMessages = (messages: readonly ModelMessage[]) =>
  estimateContextTokens(measureContext({ messages: [...messages] }));

/** Boundaries that never separate a call/approval from its correlated result. */
export const safeRetentionCuts = (messages: readonly ModelMessage[]) => {
  let systemCount = 0;
  while (messages[systemCount]?.role === "system") systemCount++;
  const origins = new Map<string, number>();
  const crossings = new Array<number>(messages.length + 1).fill(0);
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      let origin: string | undefined, reference: string | undefined;
      if (part.type === "tool-call") origin = `tool:${part.toolCall.id}`;
      if (part.type === "tool-result") reference = `tool:${part.toolResult.toolCallId}`;
      if (part.type === "provider-data" && part.data && typeof part.data === "object" && !Array.isArray(part.data)) {
        if (part.data.type === "mcp_approval_request" && typeof part.data.id === "string") origin = `approval:${part.provider}:${part.data.id}`;
        if (part.data.type === "mcp_approval_response" && typeof part.data.approval_request_id === "string") reference = `approval:${part.provider}:${part.data.approval_request_id}`;
      }
      if (origin) origins.set(origin, index);
      const from = reference ? origins.get(reference) : undefined;
      if (from !== undefined && from < index) {
        crossings[from + 1]!++;
        crossings[index + 1]!--;
      }
    }
  });
  const cuts: number[] = [];
  let crossingCount = 0;
  for (let cut = 0; cut < messages.length; cut++) {
    crossingCount += crossings[cut]!;
    if (cut > systemCount && messages[cut]!.role !== "tool" && crossingCount === 0) cuts.push(cut);
  }
  return cuts;
};

/** SDK adapter: estimateTokens runs synchronously before keepRecentMessages is
 * read. The consumer regression tests pin this ordering to the installed SDK.
 * The SDK still owns protected groups, pending approvals, records and checkpoints.
 */
export const createAdaptiveCompaction = (config: {
  maxMessages: number; maxEstimatedInputTokens: number; keepRecentMessages: number;
}, options: { tools?: ToolSet; remainingInputTokens?: () => number; compactor?: AgentCompactionOptions["compactor"]; auxiliary?: AgentCompactionOptions["auxiliary"] } = {}): AgentCompactionOptions => {
  let retained = config.keepRecentMessages;
  let systemTokens = 0;
  let protectedTailTokens = 1024;
  const toolTokens = estimateContextTokens(measureContext({ messages: [], ...(options.tools ? { tools: options.tools } : {}) })) - 64;
  const summaryAllowance = 1500; // 4,000 characters plus the SDK envelope.
  const threshold = () => {
    const remaining = options.remainingInputTokens?.() ?? Infinity;
    // Leave room for three further requests when the cumulative budget is tight.
    // Static policy/catalog overhead is irreducible; the transport budget remains
    // authoritative when even the smallest useful prompt no longer fits.
    // This is a compaction target, not the provider's context limit. A complete
    // recent interaction may exceed it; transport/context admission still owns
    // the actual hard limit. Never fail solely because that group beats a target.
    return Math.ceil(toolTokens + Math.max(systemTokens + summaryAllowance + protectedTailTokens,
      Math.min(config.maxEstimatedInputTokens, remaining / 3 - toolTokens)));
  };
  return {
    ...(options.auxiliary ? { auxiliary: options.auxiliary } : {}),
    maxMessages: config.maxMessages,
    get maxEstimatedInputTokens() { return threshold(); },
    get keepRecentMessages() { return retained; },
    estimateTokens(messages) {
      const measured = measureContext({ messages: [...messages] });
      systemTokens = Math.ceil(measured.systemCharacters / 3);
      const cuts = safeRetentionCuts(messages);
      const tailCharacters = new Array<number>(messages.length + 1).fill(0);
      for (let i = messages.length - 1; i >= 0; i--) tailCharacters[i] = tailCharacters[i + 1]! + JSON.stringify(messages[i]).length;
      // A three-request reserve is a heuristic, not a smaller hard budget.
      // Its floor must fit the newest indivisible call/result group; otherwise
      // the SDK rejects useful compaction even when the actual token budget fits.
      const newestCut = cuts.at(-1);
      protectedTailTokens = newestCut === undefined ? 1024 : Math.max(1024, Math.ceil(tailCharacters[newestCut]! / 3) + 64);
      const target = Math.max(1024, Math.floor(threshold() * 0.65) - toolTokens - systemTokens - summaryAllowance);
      // Prefer the largest recent tail that fits both budgets. If the newest
      // protected group exceeds the target, retain it under the threshold floor.
      const cut = cuts.find(index => messages.length - index <= config.keepRecentMessages &&
        Math.ceil(tailCharacters[index]! / 3) + 64 <= target) ?? cuts.at(-1);
      retained = cut === undefined ? 1 : Math.max(1, messages.length - cut);
      return estimateContextTokens(measured) + toolTokens;
    },
    compactor: options.compactor ?? (({ messages }) => {
      const budget = Math.max(128, Math.min(4000, Math.floor(JSON.stringify(messages).length / 2)));
      const { summary, truncated } = summarizeHarnessMessages(messages, budget);
      return { summary, metadata: { strategy: COMPACTION_STRATEGY, policy: "adaptive-tokens-v2",
        sourceMessages: messages.length, truncated, targetRatio: 0.65, toolTokens } };
    })
  };
};
