import type { AgentCompactionOptions, ModelMessage, ToolSet } from "@zhivex-ai/core";
import { createTextMessage } from "@zhivex-ai/core";
import { COMPACTION_STRATEGY, summarizeHarnessMessages } from "./compaction.js";
import { estimateContextTokens, measureContext } from "./context-metrics.js";

export const estimateMessages = (messages: readonly ModelMessage[]) =>
  estimateContextTokens(measureContext({ messages: [...messages] }));

export const ADAPTIVE_COMPACTION_POLICY = "adaptive-tokens-v2";

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
}, options: { tools?: ToolSet; remainingInputTokens?: () => number } = {}): AgentCompactionOptions => {
  let retained = config.keepRecentMessages;
  let systemTokens = 0;
  let systemMessages: readonly ModelMessage[] = [];
  const toolTokens = estimateContextTokens(measureContext({ messages: [], ...(options.tools ? { tools: options.tools } : {}) })) - 64;
  const summaryAllowance = 1500; // 4,000 characters plus the SDK envelope.
  const threshold = () => {
    const remaining = options.remainingInputTokens?.() ?? Infinity;
    // Leave room for three further requests when the cumulative budget is tight.
    // Static policy/catalog overhead is irreducible; the transport budget remains
    // authoritative when even the smallest useful prompt no longer fits.
    return Math.ceil(toolTokens + Math.min(config.maxEstimatedInputTokens,
      Math.max(systemTokens + summaryAllowance + 1024, remaining / 3 - toolTokens)));
  };
  return {
    maxMessages: config.maxMessages,
    get maxEstimatedInputTokens() { return threshold(); },
    get keepRecentMessages() { return retained; },
    estimateTokens(messages) {
      const measured = measureContext({ messages: [...messages] });
      let systemCount = 0;
      while (messages[systemCount]?.role === "system") systemCount++;
      systemMessages = messages.slice(0, systemCount);
      systemTokens = Math.ceil(measured.systemCharacters / 3);
      const target = Math.max(1024, Math.floor(threshold() * 0.65) - toolTokens - systemTokens - summaryAllowance);
      const cuts = safeRetentionCuts(messages);
      const tailCharacters = new Array<number>(messages.length + 1).fill(0);
      for (let i = messages.length - 1; i >= 0; i--) tailCharacters[i] = tailCharacters[i + 1]! + JSON.stringify(messages[i]).length;
      // Prefer the largest recent tail that fits both budgets. If the newest
      // protected group cannot fit, retain it and let the SDK fail closed.
      const cut = cuts.find(index => messages.length - index <= config.keepRecentMessages &&
        Math.ceil(tailCharacters[index]! / 3) + 64 <= target) ?? cuts.at(-1);
      retained = cut === undefined ? 1 : Math.max(1, messages.length - cut);
      return estimateContextTokens(measured) + toolTokens;
    },
    compactor({ messages, retainedMessages }) {
      const budget = Math.max(128, Math.min(4000, Math.floor(JSON.stringify(messages).length / 2)));
      let result = summarizeHarnessMessages(messages, budget);
      // Size the exact SDK envelope, including JSON escaping. A character-only
      // allowance can overflow beside a protected tail even when a shorter
      // structured summary fits. Never trim system messages or correlated groups.
      const fits = (summary: string) => estimateMessages([
        ...systemMessages,
        createTextMessage("assistant", `[Compacted prior conversation]\n${summary}`),
        ...retainedMessages
      ]) + toolTokens <= threshold();
      if (!fits(result.summary)) {
        let low = 128;
        let high = budget - 1;
        let fitted: typeof result | undefined;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = summarizeHarnessMessages(messages, middle);
          if (fits(candidate.summary)) {
            fitted = candidate;
            low = middle + 1;
          } else high = middle - 1;
        }
        // If the protected material cannot fit, the SDK's unchanged validation
        // still rejects this minimum summary; no budget or receipt is bypassed.
        result = fitted ?? summarizeHarnessMessages(messages, 128);
      }
      const { summary, truncated } = result;
      return { summary, metadata: { strategy: COMPACTION_STRATEGY, policy: ADAPTIVE_COMPACTION_POLICY,
        sourceMessages: messages.length, truncated, targetRatio: 0.65, toolTokens } };
    }
  };
};
