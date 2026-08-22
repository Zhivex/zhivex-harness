import { describe, expect, test } from "bun:test";

import {
  DEFAULT_APPROVAL_SUMMARY_CHARACTERS,
  formatApproval,
  formatTerminalEvent,
  formatTerminalHeader,
  resolveTerminalApprovals,
  sanitizeTerminalText,
  terminalSupportsColor
} from "../src/terminal-ui.js";

const approval = (
  name: string,
  argumentsText: string,
  overrides: Record<string, unknown> = {}
) => ({
  kind: "local-tool",
  provider: "fixture",
  id: `approval-${name}`,
  name,
  arguments: argumentsText,
  rawData: null,
  ...overrides
}) as never;

describe("terminal text safety", () => {
  test("escapes terminal controls and bidirectional overrides", () => {
    const unsafe = "before\u001b[2J\rhidden\u009dosc\u202eafter";
    const safe = sanitizeTerminalText(unsafe);

    expect(safe).toContain("\\u001b[2J");
    expect(safe).toContain("\\u000dhidden");
    expect(safe).toContain("\\u009dosc");
    expect(safe).toContain("\\u202eafter");
    expect(safe).not.toContain("\u001b");
    expect(safe).not.toContain("\u202e");
  });

  test("enables color only for an eligible terminal", () => {
    expect(terminalSupportsColor(true, { TERM: "xterm-256color" })).toBe(true);
    expect(terminalSupportsColor(false, { TERM: "xterm-256color" })).toBe(false);
    expect(terminalSupportsColor(true, { TERM: "dumb" })).toBe(false);
    expect(terminalSupportsColor(true, { TERM: "xterm", NO_COLOR: "" })).toBe(false);
    expect(terminalSupportsColor(true, { TERM: "xterm", FORCE_COLOR: "0" })).toBe(false);
  });
});

describe("approval cards", () => {
  test("shows complete payloads for every reviewed edit transaction", () => {
    const tail = "TAIL_OF_REVIEWED_CHANGE";
    const argumentsText = JSON.stringify({
      changes: [{
        path: "src/index.ts",
        expectedDigest: `sha256:${"a".repeat(64)}`,
        content: `${"x".repeat(DEFAULT_APPROVAL_SUMMARY_CHARACTERS + 100)}${tail}`
      }],
      command: "npm",
      args: ["test"]
    });

    for (const name of [
      "apply_patch",
      "apply_reviewed_edits",
      "verify_and_apply_reviewed_edits"
    ]) {
      const card = formatApproval(approval(name, argumentsText));
      expect(card).toContain(tail);
      expect(card).not.toContain("characters omitted");
    }
  });

  test("bounds unknown tools by default and exposes a complete detail view", () => {
    const tail = "TAIL_OF_UNKNOWN_PAYLOAD";
    const argumentsText = JSON.stringify({ value: `${"x".repeat(1_400)}${tail}` });
    const request = approval("remote_unknown_tool", argumentsText, {
      kind: "provider",
      serverLabel: "fixture-mcp"
    });
    const summary = formatApproval(request, { maxSummaryCharacters: 80 });
    const full = formatApproval(request, { detail: "full", maxSummaryCharacters: 80 });

    expect(summary).toContain("characters omitted; press v");
    expect(summary).not.toContain(tail);
    expect(full).toContain(tail);
    expect(full).not.toContain("characters omitted");
  });

  test("sanitizes provider-controlled labels and malformed argument text", () => {
    const card = formatApproval(approval("bad\u001b[2Jname", "raw\rpayload", {
      kind: "provider",
      serverLabel: "server\u202ename"
    }));

    expect(card).toContain("bad\\u001b[2Jname");
    expect(card).toContain("raw\\u000dpayload");
    expect(card).toContain("server\\u202ename");
    expect(card).not.toContain("\u001b");
    expect(card).not.toContain("\u202e");
  });
});

describe("interactive approval resolution", () => {
  test("supports explicit approval and denial", async () => {
    const answers = ["y", "n"];
    const output: string[] = [];
    const result = await resolveTerminalApprovals([
      approval("move_file", JSON.stringify({ source: "a", destination: "b" })),
      approval("quarantine_file", JSON.stringify({ path: "old.ts" }))
    ], {
      ask: async () => answers.shift()!,
      write: (text) => output.push(text)
    });

    expect(result).toEqual([
      expect.objectContaining({ approvalRequestId: "approval-move_file", approve: true }),
      expect.objectContaining({ approvalRequestId: "approval-quarantine_file", approve: false })
    ]);
    expect(output.join("\n")).toContain("Approval required 1/2");
    expect(output.join("\n")).toContain("Approval required 2/2");
  });

  test("shows a full payload on v and then asks again", async () => {
    const tail = "VISIBLE_ONLY_IN_FULL_VIEW";
    const answers = ["v", "yes"];
    const output: string[] = [];
    const result = await resolveTerminalApprovals([
      approval("remote_unknown_tool", JSON.stringify({ value: `${"x".repeat(200)}${tail}` }))
    ], {
      ask: async () => answers.shift()!,
      write: (text) => output.push(text),
      maxSummaryCharacters: 40
    });

    expect(result?.[0]).toMatchObject({ approve: true });
    expect(output[0]).not.toContain(tail);
    expect(output.join("\n")).toContain("Complete approval payload");
    expect(output.join("\n")).toContain(tail);
  });

  test("quit discards earlier answers and keeps the whole batch pending", async () => {
    const answers = ["y", "q"];
    const result = await resolveTerminalApprovals([
      approval("move_file", "{}"),
      approval("restore_file", "{}")
    ], {
      ask: async () => answers.shift()!,
      write: () => undefined
    });

    expect(result).toBeUndefined();
  });

  test("prompt closure keeps approvals pending but unexpected failures propagate", async () => {
    const closed = new Error("closed");
    closed.name = "AbortError";
    await expect(resolveTerminalApprovals([approval("move_file", "{}")], {
      ask: async () => { throw closed; },
      write: () => undefined
    })).resolves.toBeUndefined();

    await expect(resolveTerminalApprovals([approval("move_file", "{}")], {
      ask: async () => { throw new Error("terminal write failed"); },
      write: () => undefined
    })).rejects.toThrow("terminal write failed");
  });

  test("re-prompts invalid input and treats an empty answer as denial", async () => {
    const answers = ["maybe", ""];
    const output: string[] = [];
    const result = await resolveTerminalApprovals([approval("move_file", "{}")], {
      ask: async () => answers.shift()!,
      write: (text) => output.push(text)
    });

    expect(result?.[0]).toMatchObject({ approve: false });
    expect(output.join("\n")).toContain("Choose y, n, v, or q.");
  });
});

describe("terminal event rendering", () => {
  test("renders useful activity without tool payloads or raw errors", () => {
    const toolCall = formatTerminalEvent({
      type: "tool-call",
      toolCall: { id: "call-1", name: "read_file", input: { secret: "DO_NOT_PRINT" } }
    } as never);
    const toolResult = formatTerminalEvent({
      type: "tool-result",
      toolResult: {
        toolCallId: "call-1",
        toolName: "read_file",
        output: { secret: "DO_NOT_PRINT" },
        isError: false
      }
    } as never);
    const failure = formatTerminalEvent({
      type: "error",
      error: new Error("SECRET_PROVIDER_FAILURE")
    } as never);

    expect(toolCall).toBe("↳ tool · read_file");
    expect(toolResult).toBe("✓ tool · read_file");
    expect(failure).toBe("✗ provider stream failed");
    expect(`${toolCall}${toolResult}${failure}`).not.toContain("DO_NOT_PRINT");
    expect(`${toolCall}${toolResult}${failure}`).not.toContain("SECRET_PROVIDER_FAILURE");
  });

  test("leaves text deltas to the streaming output and applies optional color", () => {
    expect(formatTerminalEvent({ type: "text-delta", textDelta: "model text" } as never))
      .toBeUndefined();
    expect(formatTerminalEvent({
      type: "agent-run-start",
      currentStep: 0,
      maxSteps: 12
    } as never, { color: true })).toContain("\u001b[");
    expect(formatTerminalHeader({
      version: "0.11.0",
      provider: "openai",
      model: "gpt-test",
      sessionId: "session-1"
    })).toBe("Zhivex Harness 0.11.0 · openai/gpt-test\nsession session-1");
  });
});
