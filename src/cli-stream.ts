import type { AgentStreamEvent } from "@zhivex-ai/agents";

export const CLI_JSON_SCHEMA_VERSION = 1 as const;
export const CLI_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Convert runtime events into a stable, line-oriented CLI contract.
 *
 * Tool inputs, tool outputs, provider payloads, model messages, and error text
 * are deliberately omitted: they can contain repository content or secrets.
 */
export const streamEventDocument = (event: AgentStreamEvent, sequence = 0) => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("JSONL event sequence must be a non-negative integer.");
  }
  const base = {
    schemaVersion: CLI_EVENT_SCHEMA_VERSION,
    kind: "run-event" as const,
    sequence,
    type: event.type
  };

  switch (event.type) {
    case "text-delta":
      return { ...base, textDelta: event.textDelta };
    case "tool-call":
      return { ...base, toolCallId: event.toolCall.id, toolName: event.toolCall.name };
    case "tool-result":
      return {
        ...base,
        toolCallId: event.toolResult.toolCallId,
        toolName: event.toolResult.toolName,
        isError: event.toolResult.isError
      };
    case "tool-approval-request":
    case "agent-approval-request":
      return {
        ...base,
        approvalRequestId: event.approval.id,
        approvalKind: event.approval.kind ?? "provider",
        toolName: event.approval.name
      };
    case "agent-approval-resolved":
      return {
        ...base,
        approvalRequestId: event.approval.approvalRequestId,
        approved: event.approval.approve
      };
    case "provider-data":
      return { ...base, provider: event.provider };
    case "image-generation":
      return {
        ...base,
        provider: event.provider,
        partial: event.partial,
        ...(event.id ? { id: event.id } : {}),
        ...(event.index !== undefined ? { index: event.index } : {})
      };
    case "finish":
      return {
        ...base,
        ...(event.finishReason ? { finishReason: event.finishReason } : {}),
        ...(event.usage ? { usage: event.usage } : {})
      };
    case "error":
      return { ...base, error: "Provider stream failed." };
    case "agent-run-start":
      return { ...base, currentStep: event.currentStep, maxSteps: event.maxSteps };
    case "agent-step-start":
      return { ...base, stepIndex: event.stepIndex };
    case "agent-step-finish":
      return {
        ...base,
        stepIndex: event.step.index,
        status: event.step.status,
        toolCalls: event.step.toolResults.length
      };
    case "agent-compaction":
      return {
        ...base,
        compactionId: event.compaction.id,
        reasons: event.compaction.reasons,
        messageCountBefore: event.compaction.messageCountBefore,
        messageCountAfter: event.compaction.messageCountAfter
      };
    case "agent-run-finish":
      return {
        ...base,
        runId: event.state.runId,
        status: event.status,
        provider: event.state.provider,
        model: event.state.modelId
      };
  }
};

export const serializeStreamEvent = (event: AgentStreamEvent, sequence = 0) =>
  JSON.stringify(streamEventDocument(event, sequence));
