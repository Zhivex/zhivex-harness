import { expect, test } from "bun:test";
import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { ActivityStream } from "../src/cli/terminal/activity-stream.js";
import { ActivityHistory } from "../src/cli/terminal/activity-history.js";
import { streamSink } from "../src/cli/presentation.js";

const replacement = (id: string, newText: string, path = "packages/azure-openai/src/index.ts", intent?: string) => ({
  id,
  name: "apply_reviewed_replacement",
  input: {
    path,
    oldText: "a",
    newText,
    ...(intent ? { intent } : {})
  }
});

test("a read, a search, and one edit name the target", () => {
  const stream = new ActivityStream({ added: 0, removed: 0 });
  stream.noteCall({ id: "read", name: "read_file", input: { path: "src/x.ts", startLine: 120, endLine: 180 } });
  stream.noteResult({ toolCallId: "read", toolName: "read_file" });
  expect(stream.flush().map(item => item.live)).toEqual(["Read src/x.ts L120-180"]);
  stream.noteCall({ id: "search", name: "search_files", input: { query: "fetch(" } });
  stream.noteResult({
    toolCallId: "search",
    toolName: "search_files",
    output: { matches: Array.from({ length: 14 }, (_, index) => ({ path: `src/f${index}.ts` })) }
  });
  expect(stream.flush().map(item => item.live)).toEqual(['Searched "fetch(" in 14 files']);
  stream.noteCall(replacement("edit", "require rootDir\nsecond\nthird"));
  stream.noteResult({ toolCallId: "edit", toolName: "apply_reviewed_replacement" });
  expect(stream.flush().map(item => item.live)).toEqual(["Edited index.ts +3 −1: require rootDir"]);
  expect(stream.diff).toEqual({ added: 3, removed: 1 });
});

test("consecutive edits of one file collapse to a net line and attempt count", () => {
  const stream = new ActivityStream({ added: 0, removed: 0 });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const call = replacement(String(attempt), attempt === 4 ? "require rootDir\nsecond\nthird" : "b", "packages/azure-openai/src/index.ts", attempt === 1 ? "require rootDir" : undefined);
    stream.noteCall(call);
    expect(stream.noteResult({ toolCallId: call.id, toolName: call.name }).map(item => item.live)).toEqual([]);
  }
  const [group] = stream.flush();
  expect(group?.live).toBe("Edited index.ts +6 −4: require rootDir · 4 attempts");
  expect(group?.history[0]).toBe(group?.live);
  expect(group?.history).toHaveLength(5);
  expect(group?.history[1]).toContain("attempt 1");
  expect(group?.live).not.toContain("packages/azure-openai");
});

test("a run of reads collapses until /activity expands it", () => {
  const stream = new ActivityStream({ added: 0, removed: 0 });
  for (const [id, path] of [["1", "src/a.ts"], ["2", "src/b.ts"], ["3", "src/c.ts"]] as const) {
    stream.noteCall({ id, name: "read_file", input: { path, startLine: 1, endLine: 10 } });
    stream.noteResult({ toolCallId: id, toolName: "read_file" });
  }
  const [group] = stream.flush();
  expect(group?.live).toBe("Explored 3 files · Read src/a.ts L1-10 · /activity");
  expect(group?.history.slice(1)).toEqual([
    "  Read src/a.ts L1-10",
    "  Read src/b.ts L1-10",
    "  Read src/c.ts L1-10"
  ]);
  expect(group?.live).not.toContain("src/b.ts");
});

test("a binary read names the NUL line and an unknown tool stays unnamed", () => {
  const stream = new ActivityStream({ added: 0, removed: 0 });
  stream.noteCall(replacement("edit", "require rootDir\nsecond\nthird"));
  stream.noteResult({ toolCallId: "edit", toolName: "apply_reviewed_replacement" });
  const lines = stream.noteResult({
    toolCallId: "read",
    toolName: "read_file",
    isError: true,
    error: { message: "The file appears to be binary and cannot be read as text: NUL byte at L2283." }
  });
  expect(lines.map(item => item.live)).toEqual([
    "Edited index.ts +3 −1: require rootDir",
    "✗ Reading a file · file is binary: NUL byte at L2283. Restore the text version, then read it again."
  ]);
  stream.noteCall({ id: "secret", name: "SECRET_TOOL", input: { path: "SECRET" } });
  const hidden = stream.noteResult({ toolCallId: "secret", toolName: "SECRET_TOOL" });
  expect(hidden.map(item => item.live)).toEqual(["Ran tool"]);
  expect(JSON.stringify(hidden)).not.toContain("SECRET");
});

test("the compact stream prints one grouped edit and keeps the cause", async () => {
  const history = new ActivityHistory();
  const tracker = { streamedText: false, activityHistory: history, consoleView: true, turnDiff: { added: 0, removed: 0 } };
  const sink = streamSink({ json: false, jsonl: false }, tracker, true);
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  const call = (id: string, name: string, input: unknown) =>
    sink({ type: "tool-call", toolCall: { id, name, input } } as AgentStreamEvent);
  const result = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    sink({ type: "tool-result", toolResult: { toolCallId: id, toolName: name, isError: false, ...extra } } as AgentStreamEvent);
  try {
    await call("read", "read_file", { path: "src/x.ts", startLine: 120, endLine: 180 });
    await result("read", "read_file");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await call(String(attempt), "apply_reviewed_replacement", {
        path: "packages/azure-openai/src/index.ts",
        oldText: "a",
        newText: attempt === 4 ? "require rootDir\nsecond\nthird" : "b",
        ...(attempt === 1 ? { intent: "require rootDir" } : {})
      });
      await result(String(attempt), "apply_reviewed_replacement");
    }
    await sink({ type: "agent-run-finish", status: "completed" } as AgentStreamEvent);
    await result("broken", "read_file", {
      isError: true,
      error: { message: "file is binary after edit: NUL byte at L2283. The edit was reverted. Read the file again before retrying." }
    });
  } finally {
    process.stderr.write = original;
  }
  const printed = chunks.join("");
  expect(printed).toContain("Read src/x.ts L120-180");
  expect(printed).toContain("Edited index.ts +6 −4: require rootDir · 4 attempts");
  expect(printed).toContain("file is binary after edit: NUL byte at L2283");
  expect(printed).toContain("Read the file again before retrying.");
  expect(printed).not.toContain("Activity · reads");
  expect(printed).not.toContain("Reviewed replacement applied");
  expect(printed).not.toContain("Applied 1 file change");
  expect(printed.match(/Edited index.ts/g)).toHaveLength(1);
  expect(history.render()).toContain("attempt 1");
  expect(history.render()).not.toContain("Preparing apply_reviewed_replacement");
});

test("a move names both paths", () => {
  const stream = new ActivityStream({ added: 0, removed: 0 });
  stream.noteCall({ id: "move", name: "move_file", input: { source: "src/a.ts", destination: "src/b.ts" } });
  expect(stream.noteResult({ toolCallId: "move", toolName: "move_file" }).map(item => item.live)).toEqual(["Moved src/a.ts → src/b.ts"]);
});
