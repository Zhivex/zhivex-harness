import { describe, expect, test } from "bun:test";

import { CLI_EVENT_SCHEMA_VERSION, serializeStreamEvent, streamEventDocument } from "../src/cli-stream.js";

describe("CLI JSONL stream contract", () => {
  test("emits text deltas as one versioned event", () => {
    expect(streamEventDocument({ type: "text-delta", textDelta: "hello" })).toEqual({
      schemaVersion: CLI_EVENT_SCHEMA_VERSION,
      kind: "run-event",
      sequence: 0,
      type: "text-delta",
      textDelta: "hello"
    });
  });

  test("does not expose tool inputs, outputs, provider payloads, or error messages", () => {
    const documents = [
      serializeStreamEvent({
        type: "tool-call",
        toolCall: { id: "call-1", name: "read_file", input: { secret: "tool-input-secret" } }
      }),
      serializeStreamEvent({
        type: "tool-result",
        toolResult: {
          toolCallId: "call-1",
          toolName: "read_file",
          output: { secret: "tool-output-secret" },
          isError: false
        }
      }),
      serializeStreamEvent({
        type: "provider-data",
        provider: "fixture",
        data: { secret: "provider-secret" }
      }),
      serializeStreamEvent({ type: "error", error: new Error("error-secret") })
    ].join("\n");

    expect(documents).not.toContain("tool-input-secret");
    expect(documents).not.toContain("tool-output-secret");
    expect(documents).not.toContain("provider-secret");
    expect(documents).not.toContain("error-secret");
    expect(documents).toContain("read_file");
    expect(documents).toContain("Provider stream failed");
  });

  test("redacts approval arguments and durable state messages", () => {
    const approval = serializeStreamEvent({
      type: "agent-approval-request",
      approval: {
        provider: "local",
        id: "approval-1",
        name: "apply_patch",
        arguments: "patch-secret",
        rawData: { secret: "raw-secret" }
      }
    });
    const finish = serializeStreamEvent({
      type: "agent-run-finish",
      status: "completed",
      state: {
        schemaVersion: 1,
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-test",
        status: "completed",
        messages: [{ role: "user", parts: [{ type: "text", text: "message-secret" }] }],
        steps: [],
        toolResults: [],
        currentStep: 1,
        maxSteps: 2,
        outputText: "output-secret",
        pendingApprovals: []
      }
    });

    expect(JSON.parse(approval)).toMatchObject({
      approvalRequestId: "approval-1",
      toolName: "apply_patch"
    });
    expect(`${approval}\n${finish}`).not.toContain("patch-secret");
    expect(`${approval}\n${finish}`).not.toContain("raw-secret");
    expect(`${approval}\n${finish}`).not.toContain("message-secret");
    expect(`${approval}\n${finish}`).not.toContain("output-secret");
  });
});
