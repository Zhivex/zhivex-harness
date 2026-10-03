import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ConsoleInput } from "../src/cli/console/console-input.js";
import { consoleLines, consoleLabel, consoleStateLines } from "../src/cli/console/console-presentation.js";
import { reviewFrame } from "../src/cli/console/console-review.js";
import { ConsoleRunView } from "../src/cli/console/console-run-view.js";
import { formatConsoleOutcome } from "../src/cli/console/console-outcome.js";
import { checkpointRecovery } from "../src/cli/console/console-recovery.js";
import { resolveTerminalApprovals } from "../src/cli/terminal/terminal-ui.js";
import { terminalCellWidth } from "../src/cli/terminal/terminal-table.js";

const state = {model: "openai/gpt-5.6-luna", status: "approval pending", contextTokens: 1240,
  nextLimitUsd: 1, runUsage: {estimatedUsd: null, limitUsd: 0.25, usageComplete: false}};
const items = ["Reject", "Allow once", "Allow exact check this session", "View technical details", "Leave pending"].map((label, index) => ({label, index, value: index}));

test("44x24 review preserves every code character, decisions and unknown/original versus next-run cost", () => {
  const source = "-export const greeting = (name) => `Hi, ${name}`;";
  expect(consoleLines(source, 43).join("")).toBe(source);
  const frame = reviewFrame({title: "Permission required 1/1", body: source + "\n" + "+change\n".repeat(90), state}, items, 0, "", 0, 44, 24);
  expect(frame.lines.length).toBe(24);
  expect(frame.lines.every(line => terminalCellWidth(line) <= 43)).toBe(true);
  expect(frame.lines).toContain("> Reject");
  for (const item of items) expect(frame.lines.join("\n")).toContain(item.label);
  expect(frame.lines.join("\n")).toContain("INCOMPLETE");
  expect(frame.lines.join("\n")).toContain("$0.250000");
  expect(frame.lines.join("\n")).toContain("$1.000000");
  const last = reviewFrame({title: "Permission required", body: source + "\n" + "+change\n".repeat(90), state}, items, 0, "", 9999, 44, 24);
  expect(last.offset).toBeGreaterThan(0);
  expect(last.lines).toContain("> Reject");
});

test("terminal width uses graphemes; controls remain inert and context never invents a percentage", () => {
  expect(terminalCellWidth(consoleLabel("你好e\u0301 world", 6))).toBeLessThanOrEqual(6);
  expect(consoleLines("\x1b[2J payload", 20).join("")).toContain("\\u001b[2J");
  expect(consoleStateLines(state).join("\n")).not.toContain("%");
  expect(consoleStateLines({...state, runUsage: {estimatedUsd: 0, limitUsd: null, usageComplete: true}}).join("\n")).toContain("$0.000000 / none cap");
});

test("approval pager keeps a fresh reject default after paste, resize and details; escape leaves pending", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, {columns: 44, rows: 24});
  let rendered = ""; output.on("data", chunk => { rendered += chunk.toString(); });
  const console = new ConsoleInput(input, output);
  try {
    const answer = console.review({title: "Permission required", body: "diff\n".repeat(100), state}, items);
    let answered = false; void answer.then(() => {answered = true;});
    input.write("\x1b[200~Allow once\x1b[201~\r");
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    input.write("\x1b[6~");
    expect(rendered).toContain("Review lines");
    Object.assign(output, {columns: 80}); output.emit("resize");
    expect(rendered).toContain("> Reject");
    input.write("\r"); expect(await answer).toBe(0);
    expect(rendered).toContain("\x1b[?1049l");
    const pending = console.review({title: "Permission required", body: "diff", state}, items);
    input.write("\x03"); expect(await pending).toBeUndefined();
  } finally { console.close(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; }
});

test("diff-first review retains full technical identity and whole-batch/exact grant semantics", async () => {
  const approval = {id: "approval-1", provider: "openai" as const, kind: "local-tool" as const,
    name: "apply_reviewed_edits", arguments: '{"changes":[{"path":"safe.txt","content":"new","expectedDigest":null}]}', inputDigest: "sha256:original", rawData: null};
  const bodies: string[] = [], decisions = ["v", "y", "q"];
  const response = await resolveTerminalApprovals([approval, {...approval, id: "approval-2"}], {
    ask: async () => {throw new Error("Unexpected fallback");}, write: () => {throw new Error("Unexpected payload dump");},
    fileDiff: async () => "Reviewed file diff · proposal\n--- safe.txt\n+++ safe.txt\n+new",
    review: async (review, choices) => {bodies.push(review.body); expect(choices[0]?.label).toBe("Reject"); return decisions.shift();},
  });
  expect(response).toBeUndefined();
  expect(bodies[0]).toContain("+++ safe.txt"); expect(bodies[0]).not.toContain('"expectedDigest"');
  expect(bodies[1]).toContain("sha256:original"); expect(bodies[1]).toContain('"expectedDigest"');
  const unknown: string[] = [];
  await resolveTerminalApprovals([{...approval, kind: "provider"}], {
    ask: async () => "n", write: () => {}, fileDiff: async () => "Reviewed file diff · spoofed",
    review: async view => {unknown.push(view.body); return "n";},
  });
  expect(unknown[0]).toContain('"expectedDigest"');
  let verifier = "";
  await resolveTerminalApprovals([{...approval, name: "verify_and_apply_reviewed_edits", arguments: '{"changes":[],"checks":[{"check":"test","expectedScript":"node --test exact.mjs"}]}'}], {
    ask: async () => "n", write: () => {}, fileDiff: async () => "Reviewed file diff · checked\n+new",
    review: async view => {verifier = view.body; return "n";},
  });
  expect(verifier).toContain("Checks pending · conditional apply");
  expect(verifier).toContain("node --test exact.mjs");
});

test("conversation completion retains tool failure and verification distinctions; recovery never advises blind retry", () => {
  const outcome = formatConsoleOutcome({status: "completed", toolResults: [{toolName: "read_file", toolCallId: "read-1", isError: true}]}, 0, 1);
  expect(outcome).toContain("Conversation: completed"); expect(outcome).toContain("1 other tool errors");
  expect(outcome).toContain("1 rejected decisions"); expect(outcome).toContain("no check receipts");
  const recovery = checkpointRecovery("Restore conflicts with subsequent edits or a partially applied filesystem operation; manual recovery required.");
  expect(recovery).toContain("RESTORE BLOCKED"); expect(recovery).toContain("original digests");
  expect(checkpointRecovery("arbitrary provider payload")).toBeUndefined();
  const rejected = formatConsoleOutcome({status: "completed", state: {approvalHistory: [
    {requestId: "request", provider: "openai", kind: "local-tool", approve: false, toolCallId: "read-1", resolvedAt: 1},
  ]}, toolResults: [{toolName: "read_file", toolCallId: "read-1", isError: true}]}, 0, 1);
  expect(rejected).toContain("0 other tool errors"); expect(rejected).toContain("1 rejected decisions");
});

test("review session grants commit only after the whole batch and remain exact to workspace/script", async () => {
  const check = {id: "check-1", provider: "openai" as const, kind: "local-tool" as const,
    name: "run_check", arguments: '{"check":"test","expectedScript":"node --test safe.mjs"}', rawData: null};
  const grants = new Set<string>(), answers = ["s", "q"];
  await resolveTerminalApprovals([check, {...check, id: "check-2", arguments: '{"check":"test","expectedScript":"changed"}'}], {
    ask: async () => "n", write: () => {}, workspace: "/safe", sessionGrants: grants, review: async () => answers.shift(),
  });
  expect(grants.size).toBe(0);
  await resolveTerminalApprovals([check], {ask: async () => "n", write: () => {}, workspace: "/safe", sessionGrants: grants, review: async () => "s"});
  expect(grants.size).toBe(1);
  let asked = 0;
  await resolveTerminalApprovals([check], {ask: async () => "n", write: () => {}, workspace: "/safe", sessionGrants: grants, review: async () => {asked++; return "n";}});
  expect(asked).toBe(0);
  await resolveTerminalApprovals([check], {ask: async () => "n", write: () => {}, workspace: "/different", sessionGrants: grants, review: async () => {asked++; return "n";}});
  expect(asked).toBe(1);
});

test("live state dock restores scroll region and removes resize/timers on interruption", () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const output = new PassThrough(); Object.assign(output, {isTTY: true, columns: 44, rows: 24});
  let rendered = ""; output.on("data", chunk => {rendered += chunk.toString();});
  const view = new ConsoleRunView(output, () => state, () => "1 queued · draft: inspect next");
  try {
    view.begin(); expect(rendered).toContain("INCOMPLETE"); expect(output.listenerCount("resize")).toBe(1);
    Object.assign(output, {columns: 80}); output.emit("resize");
    view.end(); const after = rendered;
    output.emit("resize"); expect(rendered).toBe(after); expect(output.listenerCount("resize")).toBe(0);
    expect(after).toContain("\x1b[r");
  } finally {view.end(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;}
});
