import { expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ConsoleInput } from "../src/cli/console/console-input.js";
import { consoleLines, consoleLabel, consoleStateLines } from "../src/cli/console/console-presentation.js";
import { reviewFrame } from "../src/cli/console/console-review.js";
import { renderReviewedDiff } from "../src/cli/console/review-diff.js";
import { ConsoleRunView } from "../src/cli/console/console-run-view.js";
import { formatConsoleOutcome, formatTurnBanner } from "../src/cli/console/console-outcome.js";
import { checkpointRecovery } from "../src/cli/console/console-recovery.js";
import { resolveTerminalApprovals } from "../src/cli/terminal/terminal-ui.js";
import { terminalCellWidth } from "../src/cli/terminal/terminal-table.js";

const state = {model: "openai/gpt-5.6-luna", status: "approval pending", contextTokens: 1240,
  nextLimitUsd: 1, runUsage: {estimatedUsd: null, limitUsd: 0.25, usageComplete: false}};
const items = ["Reject", "Allow once", "Allow exact check this session", "View technical details", "Leave pending"].map((label, index) => ({label, index, value: index}));

const menu = [
  { label: "Reject", key: "r", index: 0, value: 0 },
  { label: "Approve 1 file", key: "a", index: 1, value: 1 },
  { label: "Allow this exact check for this session", key: "s", index: 2, value: 2, detail: "Changing the script requires approval again" },
  { label: "Details", key: "d", index: 3, value: 3 },
  { label: "Decide later", key: "Esc", index: 4, value: 4, detail: "Keep it pending. /pending brings you back here." },
];

test("44x24 review preserves every code character, decisions and unknown/original versus next-run cost", () => {
  const source = "-export const greeting = (name) => `Hi, ${name}`;";
  expect(consoleLines(source, 43).join("")).toBe(source);
  const frame = reviewFrame({title: "Waiting for your decision", body: source + "\n" + "+change\n".repeat(90), files: 1}, menu, 0, "", 0, 44, 24);
  expect(frame.lines.length).toBe(24);
  expect(frame.lines.every(line => terminalCellWidth(line) <= 43)).toBe(true);
  const flat = frame.lines.join(" ");
  expect(flat).toContain("> r  Reject");
  for (const item of menu) expect(flat).toContain(item.label);
  expect(frame.lines.join("\n")).not.toContain("Filter >");
  expect(frame.lines.join("\n")).toContain("PgUp/PgDn");
  const costs = consoleStateLines(state).join("\n");
  expect(costs).toContain("INCOMPLETE");
  expect(costs).toContain("$0.250000");
  expect(costs).toContain("$1.000000");
  const last = reviewFrame({title: "Waiting for your decision", body: source + "\n" + "+change\n".repeat(90), files: 1}, menu, 0, "", 9999, 44, 24);
  expect(last.offset).toBeGreaterThan(0);
  expect(last.lines.join("\n")).toContain("Reject");
  expect(last.lines.join("\n")).toContain("End of changes");
});

test("decision labels stay whole at 44 and 80 columns and Enter only confirms the highlight", () => {
  const narrow = reviewFrame({title: "Waiting for your decision", body: "diff", files: 1, headerRight: "~/demo · openai/gpt-5.6-luna"}, menu, 0, "", 0, 44, 24);
  const narrowText = narrow.lines.join("\n");
  expect(narrowText).toContain("> r  Reject");
  expect(narrowText).toContain("Approve 1 file");
  expect(narrowText).toContain("Decide later");
  expect(narrow.lines.join(" ")).toContain("Allow this exact check for this session");
  expect(narrowText).not.toContain("…");
  const wide = reviewFrame({title: "Waiting for your decision", body: "diff", files: 1, headerRight: "~/demo · openai/gpt-5.6-luna"}, menu, 1, "", 0, 80, 24);
  const wideText = wide.lines.join("\n");
  expect(wideText).toContain("> a  Approve 1 file");
  expect(wideText).toContain("Enter confirms the highlight");
  expect(wideText).toContain("~/demo · openai/gpt-5.6-luna");
  expect(wideText).toContain("End of changes · 1 file");
  expect(narrow.lines.length).toBeLessThan(24);
  const idle = reviewFrame({title: "Waiting for your decision", body: "diff", files: 1}, menu, -1, "", 0, 80, 24);
  expect(idle.lines.some(line => line.startsWith("> "))).toBe(false);
  expect(idle.lines.join("\n")).toContain("No action highlighted");
});

test("terminal width uses graphemes; controls remain inert and context never invents a percentage", () => {
  expect(terminalCellWidth(consoleLabel("你好e\u0301 world", 6))).toBeLessThanOrEqual(6);
  expect(consoleLines("\x1b[2J payload", 20).join("")).toContain("\\u001b[2J");
  expect(consoleStateLines(state).join("\n")).not.toContain("%");
  const cappedZero = consoleStateLines({...state, runUsage: {estimatedUsd: 0, limitUsd: null, usageComplete: true}}).join("\n");
  expect(cappedZero.replaceAll("\n", "")).toContain("$0.000000");
  expect(cappedZero).not.toContain("none cap");
  expect(consoleStateLines({model: "openai/gpt-5.6-luna", status: "ready"}).join("\n")).toBe("openai/gpt-5.6-luna · ask before changes · ready");
  expect(consoleStateLines({model: "openai/gpt-5.6-luna", status: "ready", runUsage: {estimatedUsd: null, limitUsd: null, usageComplete: false}}).join("\n")).not.toContain("unknown");
});

test("approval pager does not highlight a decision until an arrow key; escape leaves pending", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, {columns: 44, rows: 24});
  let rendered = ""; output.on("data", chunk => { rendered += chunk.toString(); });
  const console = new ConsoleInput(input, output);
  try {
    const answer = console.review({title: "Waiting for your decision", body: "diff\n".repeat(100)}, items);
    let answered = false; void answer.then(() => {answered = true;});
    input.write("\x1b[200~Allow once\x1b[201~\r");
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    expect(rendered).toContain("Paste ignored · fresh keys required");
    input.write("\x1b[200~a\x1b[201~");
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    input.write("\x1b[6~");
    expect(rendered).toContain("more lines");
    expect(rendered).toContain("PgUp/PgDn");
    Object.assign(output, {columns: 80}); output.emit("resize");
    expect(rendered).not.toContain("> Reject");
    input.write("\r");
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    input.write("\x1b[B\r"); expect(await answer).toBe(0);
    expect(rendered).not.toContain("\x1b[?1049h");
    expect(rendered).not.toContain("\x1b[?1049l");
    const pending = console.review({title: "Waiting for your decision", body: "diff"}, items);
    input.write("\x03"); expect(await pending).toBeUndefined();
  } finally { console.close(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; }
});

test("a short review stays under the activity line with the decision against the diff", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, { columns: 80, rows: 40 });
  let rendered = ""; output.on("data", chunk => { rendered += chunk.toString(); });
  const ui = new ConsoleInput(input, output);
  const body = [
    '--- "packages/azure-openai/src/index.ts"',
    '+++ "packages/azure-openai/src/index.ts"',
    "@@ -2268,7 +2268,7 @@",
    "     if (!command || command.trim().length === 0) {",
    '-    if (command.includes("\0")) {',
    '+    if (command.indexOf("ok") !== -1) {',
    "     }",
  ].join("\n");
  try {
    output.write("✓ Activity · reads: 1 · other operations: 1\n");
    const answer = ui.review({
      title: "Waiting for your decision",
      body,
      files: 1,
      layout: width => renderReviewedDiff(body, width),
    }, [
      { value: "n", label: "Reject", key: "r", detail: "This change is not applied." },
      { value: "y", label: "Approve this change", key: "a", detail: "Apply only the change shown above, once." },
    ]);
    await new Promise(resolve => setImmediate(resolve));
    expect(rendered).not.toContain("\x1b[?1049h");
    expect(rendered).not.toContain("\x1b[H");
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[K/g, "");
    expect(plain).toContain('includes("\\0")');
    expect(plain).not.toContain("\0");
    const lines = plain.split(/\r?\n/);
    const activity = lines.findIndex(line => line.includes("Activity"));
    const header = lines.findIndex(line => line.includes("Review changes"));
    const removed = lines.findIndex(line => line.includes("includes"));
    const end = lines.findIndex(line => line.includes("End of changes"));
    const decision = lines.findIndex(line => line.includes("Waiting for your decision"));
    expect(header).toBe(activity + 1);
    expect(end).toBeGreaterThan(removed);
    expect(lines.slice(removed, end).every(line => line.trim() !== "")).toBe(true);
    expect(decision).toBe(end + 1);
    input.write("r");
    expect(await answer).toBe("n");
  } finally { ui.close(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; }
});

test("a dumb terminal review escapes a NUL before the numbered menu", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "dumb";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, { columns: 80, rows: 40 });
  let rendered = ""; output.on("data", chunk => { rendered += chunk.toString(); });
  const ui = new ConsoleInput(input, output);
  try {
    const answer = ui.review({ title: "Waiting for your decision", body: 'if (command.includes("\0")) {' }, [
      { value: "n", label: "Reject", key: "r" },
    ]);
    await new Promise(resolve => setImmediate(resolve));
    expect(rendered).toContain('includes("\\0")');
    expect(rendered).not.toContain("\0");
    input.write("r\n");
    expect(await answer).toBe("n");
  } finally { ui.close(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; }
});

test("a page key during review stays one sequence so the next slash command is intact", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, {columns: 44, rows: 24});
  output.resume();
  const ui = new ConsoleInput(input, output);
  try {
    const answer = ui.review({title: "Waiting for your decision", body: "diff\n".repeat(40), files: 1}, [
      {value: "n", label: "Reject", key: "r"}, {value: "y", label: "Approve 1 file", key: "a"},
    ]);
    for (const byte of Buffer.from("\x1b[6~")) input.write(Buffer.from([byte]));
    input.write("\x1b[200~Allow once\x1b[201~\r");
    await new Promise(resolve => setImmediate(resolve));
    input.write("\x1b[200~a\x1b[201~");
    await new Promise(resolve => setImmediate(resolve));
    input.write("r");
    expect(await answer).toBe("n");
    const task = ui.compose({model: "openai/gpt-5.6-luna", reasoning: "medium", status: "ready"});
    input.write("/exit\n");
    expect(await task).toBe("/exit");
  } finally { ui.close(); if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; }
});

test("a review letter chooses that item and any other letter does nothing", async () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, {columns: 80, rows: 30});
  const console = new ConsoleInput(input, output);
  const choices = [{value: "n", label: "Reject", key: "r"}, {value: "y", label: "Approve 1 file", key: "a"}];
  try {
    const answer = console.review({title: "Waiting for your decision", body: "diff"}, choices);
    let answered = false; void answer.then(() => { answered = true; });
    input.write("Az");
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    input.write("a");
    expect(await answer).toBe("y");
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

test("a replacement review lists the file, its counts, and the stated intent", async () => {
  const approval = { id: "approval-1", provider: "openai" as const, kind: "local-tool" as const,
    name: "apply_reviewed_replacement",
    arguments: JSON.stringify({ path: "packages/azure-openai/src/index.ts", oldText: "a", newText: "b", intent: "The shell tool should fail when rootDir is missing." }),
    inputDigest: "sha256:original", rawData: null };
  const diff = "Reviewed file diff · proposal\n--- \"packages/azure-openai/src/index.ts\"\n+++ \"packages/azure-openai/src/index.ts\"\n@@ -2268,1 +2268,1 @@\n-a\n+b\n";
  let fileList = "";
  let summary = "";
  await resolveTerminalApprovals([approval], {
    ask: async () => "n", write: () => {},
    fileDiff: async () => diff,
    review: async review => { fileList = review.fileList ?? ""; summary = review.summary ?? ""; return "n"; },
  });
  expect(fileList).toContain("packages/azure-openai/src/index.ts");
  expect(fileList).toContain("modify");
  expect(fileList).toContain("+1");
  expect(fileList).toContain("−1");
  expect(summary).toContain("shell tool should fail when rootDir is missing");
});

test("a stale preview offers reload and details, and no Approve", async () => {
  const approval = {id: "approval-1", provider: "openai" as const, kind: "local-tool" as const,
    name: "apply_reviewed_edits", arguments: '{"changes":[{"path":"greeting.mjs","content":"new","expectedDigest":"sha256:old"}]}', inputDigest: "sha256:original", rawData: null};
  const stale = "File diff unavailable: preconditions or text preview could not be validated. Review the complete payload below; engine checks still apply.\n";
  const fresh = "Reviewed file diff · proposal\n--- greeting.mjs\n+++ greeting.mjs\n+new\n";
  let calls = 0;
  const seen: string[][] = [];
  await resolveTerminalApprovals([approval], {
    ask: async () => { throw new Error("Unexpected fallback"); }, write: () => {},
    fileDiff: async () => { calls += 1; return calls === 1 ? stale : fresh; },
    review: async (review, choices) => {
      seen.push(choices.map(choice => choice.label));
      if (calls === 1) {
        expect(review.body).toContain("This review is out of date");
        expect(review.body).not.toContain("expectedDigest");
        return "l";
      }
      expect(review.body).toContain("+++ greeting.mjs");
      return "n";
    },
  });
  expect(seen[0]).toContain("Reject");
  expect(seen[0]).toContain("Reload review");
  expect(seen[0]?.some(label => label.startsWith("Approve"))).toBe(false);
  expect(seen[1]?.some(label => label.startsWith("Approve"))).toBe(true);
  const oversized = await resolveTerminalApprovals([approval], {
    ask: async () => "n", write: () => {},
    fileDiff: async () => "File diff unavailable: exceeds terminal preview limit. Review the complete payload below.\n",
    review: async (_review, choices) => {
      expect(choices.some(choice => choice.label.startsWith("Approve"))).toBe(true);
      expect(choices.some(choice => choice.label === "Reload review")).toBe(false);
      return "n";
    },
  });
  expect(oversized?.[0]?.approve).toBe(false);
});

test("conversation completion retains tool failure and verification distinctions; recovery never advises blind retry", () => {
  const outcome = formatConsoleOutcome({status: "completed", toolResults: [{toolName: "read_file", toolCallId: "read-1", isError: true}]}, 0, 1);
  expect(outcome).toBe("Finished with errors · 1 action failed · 0 files changed · net +0 −0 · no checks ran · /activity · 1 rejected");
  expect(outcome).not.toContain("completed");
  const recovery = checkpointRecovery("Restore conflicts with subsequent edits or a partially applied filesystem operation; manual recovery required.");
  expect(recovery).toContain("RESTORE BLOCKED"); expect(recovery).toContain("original digests");
  expect(checkpointRecovery("arbitrary provider payload")).toBeUndefined();
  const rejected = formatConsoleOutcome({status: "completed", state: {approvalHistory: [
    {requestId: "request", provider: "openai", kind: "local-tool", approve: false, toolCallId: "read-1", resolvedAt: 1},
  ]}, toolResults: [{toolName: "read_file", toolCallId: "read-1", isError: true}]}, 0, 1);
  expect(rejected).toBe("Done · 0 files changed · net +0 −0 · no checks ran · 1 rejected");
  expect(rejected).not.toContain("completed");
  const checked = formatConsoleOutcome({status: "completed", toolResults: [{toolName: "run_check", toolCallId: "check-1", isError: false, output: {exitCode: 0, command: ["bun", "--no-env-file", "run", "test"]}}]}, 1, 0, { added: 3, removed: 1 });
  expect(checked).toBe("Done · 1 file changed · net +3 −1 · checks: 1 passed, 0 failed");
  const banner = formatTurnBanner(rejected);
  expect(banner.startsWith("\n────────────────────────────────\n")).toBe(true);
  expect(banner.endsWith("\n\n")).toBe(true);
  expect(banner).toContain(rejected);
});

test("command reviews describe the command instead of a file write", async () => {
  for (const name of ["run_check", "run_environment_command", "run_environment_shell"]) {
    const choices: { label: string; detail?: string }[][] = [];
    await resolveTerminalApprovals([{ id: "command-1", provider: "openai", kind: "local-tool", name, arguments: "{}", rawData: null }], {
      ask: async () => "n", write: () => {},
      review: async (_view, items) => { choices.push([...items]); return "n"; },
    });
    expect(choices[0]?.[0]).toMatchObject({ label: "Reject", detail: "This command does not run." });
    expect(choices[0]?.find(item => item.label === "Approve this command")?.detail).toBe("Run only this command, once.");
  }
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

test("a new operation resets the dock phase, step and elapsed time", () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const output = new PassThrough(); Object.assign(output, {isTTY: true, columns: 80, rows: 28});
  let rendered = ""; output.on("data", chunk => {rendered += chunk.toString();});
  const view = new ConsoleRunView(output, () => state, () => "No queued tasks");
  try {
    view.begin();
    view.observe({type: "agent-step-start", stepIndex: 2});
    view.observe({type: "text-delta", textDelta: "Previous response"});
    view.end(); rendered = "";
    clock.mockReturnValue(12000);
    view.begin();
    expect(rendered).toContain("Waiting for model response · 0s · step 0");
    expect(rendered).not.toContain("Receiving response");
    expect(rendered).not.toContain("step 3");
    view.end(); rendered = "";
    view.begin("Running review");
    expect(rendered).toContain("Running review · 0s · step 0");
    expect(rendered).not.toContain("Waiting for model response");
    view.end(); rendered = "";
    view.begin("Testing connection");
    expect(rendered).toContain("Testing connection · 0s · step 0");
  } finally {
    view.end(); clock.mockRestore();
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
  }
});

test("restoring the dock after approval preserves the current operation's phase, step and clock", () => {
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const output = new PassThrough(); Object.assign(output, {isTTY: true, columns: 80, rows: 28});
  let rendered = ""; output.on("data", chunk => {rendered += chunk.toString();});
  const view = new ConsoleRunView(output, () => state, () => "No queued tasks");
  try {
    view.begin();
    view.observe({type: "agent-step-start", stepIndex: 2});
    view.observe({type: "text-delta", textDelta: "Current response"});
    view.end(); rendered = "";
    clock.mockReturnValue(12000);
    view.resume();
    expect(rendered).toContain("Receiving response · 11s · step 3");
    expect(output.listenerCount("resize")).toBe(1);
    view.resume();
    expect(output.listenerCount("resize")).toBe(1);
  } finally {
    view.end(); clock.mockRestore();
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
  }
});
