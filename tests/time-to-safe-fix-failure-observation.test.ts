import { describe, expect, test } from "bun:test";
import type { AgentRunState } from "@zhivex-ai/core";

import { observeTimeToSafeFixFailureState } from "../scripts/time-to-safe-fix-failure-observation.js";

const stateFixture = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "private-run-id",
  provider: "qwen",
  modelId: "private-model-id",
  status: "failed",
  messages: [{ role: "user", parts: [{ type: "text", text: "private prompt" }] }],
  steps: [],
  toolResults: [],
  currentStep: 0,
  maxSteps: 20,
  outputText: "private response",
  pendingApprovals: [],
  ...overrides
});

describe("Time-to-Safe-Fix failed state observations", () => {
  test("omits unknown counters when recovery has no state", () => {
    expect(observeTimeToSafeFixFailureState(undefined)).toEqual({
      observation: { source: "unavailable", usage: "unavailable" }
    });
  });

  test("does not turn missing usage into zero on an available state", () => {
    const result = observeTimeToSafeFixFailureState(stateFixture());
    expect(result.observation.usage).toBe("unavailable");
    expect(result).not.toHaveProperty("promptTokens");
    expect(result).not.toHaveProperty("completionTokens");
    expect(result.toolCalls).toBe(0);
    expect(result.observation.compactions).toBe(0);
  });

  test("preserves explicitly reported zero usage on completed runs", () => {
    const result = observeTimeToSafeFixFailureState(stateFixture({
      status: "completed", usage: { inputTokens: 0, outputTokens: 0 }
    }));
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.observation.usage).toBe("reported");
  });

  test("recovers partial usage and structural counters without payloads", () => {
    const result = observeTimeToSafeFixFailureState(stateFixture({
      usage: { inputTokens: 127, outputTokens: 9 },
      currentStep: 2,
      steps: [{ index: 0, status: "completed", request: { messages: [] }, toolResults: [] },
        { index: 1, status: "failed", request: { messages: [] }, toolResults: [] }],
      compactions: [{ id: "private-compaction", beforeStep: 1, createdAt: 1,
        reasons: ["message-count"], sourceDigest: "private-source", resultDigest: "private-result",
        summaryDigest: "private-digest", summary: "private summary", messageCountBefore: 4,
        messageCountAfter: 2, compactedMessageCount: 3, retainedMessageCount: 1,
        estimatedTokensBefore: 100, estimatedTokensAfter: 20 }],
      toolResults: [{ toolCallId: "private-call", toolName: "read_files", isError: true,
        error: { message: "private error" }, output: "private result" }]
    }));
    expect(result).toEqual({
      observation: { source: "persisted", status: "failed", usage: "partial", modelTurns: 2,
        compactions: 1, toolResults: 1, toolErrors: 1, currentStep: 2, maxSteps: 20 },
      promptTokens: 127, completionTokens: 9, toolCalls: 1
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("preserves per-field availability and rejects malformed token receipts", () => {
    const result = observeTimeToSafeFixFailureState(stateFixture({
      usage: { inputTokens: 12, outputTokens: Number.NaN }
    }));
    expect(result.promptTokens).toBe(12);
    expect(result).not.toHaveProperty("completionTokens");
    expect(result.observation.usage).toBe("partial");
  });

  test("marks completed state totals partial if a turn lacks a usage receipt", () => {
    const result = observeTimeToSafeFixFailureState(stateFixture({
      status: "completed", usage: { inputTokens: 12, outputTokens: 3 },
      steps: [{ index: 0, status: "completed", request: { messages: [] }, toolResults: [] }]
    }));
    expect(result.observation.usage).toBe("partial");
  });
});
