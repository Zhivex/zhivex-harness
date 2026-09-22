import { expect, test } from "bun:test";
import { ToolActivity } from "../src/cli/terminal/tool-activity.js";
import { terminalRunFailure } from "../src/cli/terminal/terminal-ui.js";

test("24 tools produce one transcript summary instead of 48 events", () => {
  let output = "";
  const activity = new ToolActivity(text => { output += text; }, false);
  for (let i = 0; i < 24; i++) { activity.start(); activity.finish("read_file"); }
  expect(output).toBe("");
  activity.flush(); activity.flush();
  expect(output).toBe("\ntools · 24 completed · 24 reads · 0 searches · 0 other\n");
});

test("TTY activity stays within one narrow line and commits at boundaries", () => {
  const writes: string[] = [];
  const activity = new ToolActivity(text => { writes.push(text); }, true, () => 20);
  activity.start(); activity.start(); activity.finish("search_many"); activity.flush();
  expect(writes.slice(1, -1).every(text => text.startsWith("\r\x1b[2K") && text.length <= 24)).toBe(true);
  expect(writes.at(-1)).toBe("\n");
  activity.finish("read_file"); activity.flush();
  expect(writes.at(-1)).toBe("\n");
});

test("runtime limits are classified without exposing arbitrary provider errors", () => {
  expect(terminalRunFailure(new Error("Agent budget exceeded including child runs: maxInputTokens limit 100000, actual 455094.")))
    .toBe("budget exceeded · maxInputTokens · 455094 / 100000");
  expect(terminalRunFailure({ message: "maxInputTokens budget exceeded" })).toContain("maxInputTokens");
  expect(terminalRunFailure(new Error("Agent exhausted maxSteps before reaching a terminal response.")))
    .toBe("step limit reached before a final response");
  expect(terminalRunFailure(new Error("SECRET_TOKEN"))).not.toContain("SECRET_TOKEN");
});

test("compact stream keeps conversation, approvals and failed checks visible", async () => {
  const { spyOn } = await import("bun:test");
  const { streamSink, flushToolActivity } = await import("../src/cli/presentation.js");
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation(((text: string) => { output += text; return true; }) as never);
  const stderr = spyOn(process.stderr, "write").mockImplementation(((text: string) => { output += text; return true; }) as never);
  try {
    const tracker = { streamedText: false };
    const send = async (event: unknown) => streamSink({ json: false, jsonl: false }, tracker, true)(event as never);
    await send({ type: "text-delta", textDelta: "Reading sources.\n" });
    for (let i = 0; i < 24; i++) {
      await send({ type: "tool-call", toolCall: { id: `${i}`, name: "read_file", input: { secret: "PRIVATE" } } });
      await send({ type: "tool-result", toolResult: { toolCallId: `${i}`, toolName: "read_file", isError: false, output: "PRIVATE" } });
    }
    await send({ type: "text-delta", textDelta: "Here is the answer.\n" });
    await send({ type: "tool-call", toolCall: { id: "check", name: "run_check", input: {} } });
    await send({ type: "tool-result", toolResult: { toolCallId: "check", toolName: "run_check", isError: false, output: { exitCode: 1, timedOut: false } } });
    await send({ type: "tool-approval-request", approval: { id: "a", name: "apply_patch" } });
    flushToolActivity(tracker);
    expect(output).toContain("Reading sources.");
    expect(output).toContain("24 completed");
    expect(output).toContain("Here is the answer.");
    expect(output).toContain("exit 1");
    expect(output).toContain("apply_patch");
    expect(output).not.toContain("tool · read_file");
    expect(output).not.toContain("PRIVATE");
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});
