import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ConsoleInput, completeConsoleCommand, MAX_CONSOLE_INPUT_BYTES } from "../src/console-input.js";
import { resolveTerminalApprovals } from "../src/terminal-ui.js";

const fixture = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, console: new ConsoleInput(input, output, false) };
};

describe("console input boundaries", () => {
  test("does not replay pasted extra lines as the next approval", async () => {
    const { input, console } = fixture();
    try {
      const task = console.question("> ");
      input.write("fix tests\ny\ny\n");
      expect(await task).toBe("fix tests");
      const approval = console.question("Approve? ");
      let answered = false;
      void approval.then(() => { answered = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(answered).toBe(false);
      input.write("n\n");
      expect(await approval).toBe("n");
    } finally { console.close(); }
  });

  test("keeps multiline slash commands literal and discards trailing send/approval", async () => {
    const { input, console } = fixture();
    try {
      const draft = console.multiline();
      input.write("task\n/approve\n\n/exit\n.end\nsend\ny\n");
      expect(await draft).toBe("task\n/approve\n\n/exit");
      const confirm = console.question("Send? ");
      input.write("no\n");
      expect(await confirm).toBe("no");
    } finally { console.close(); }
  });

  test("bounds multiline drafts and retains the console after overflow", async () => {
    const { input, console } = fixture();
    try {
      const draft = console.multiline();
      input.write(`${"x".repeat(MAX_CONSOLE_INPUT_BYTES)}\n.end\n`);
      await expect(draft).rejects.toThrow("64 KiB");
      const question = console.question("> ");
      input.write("/status\n");
      expect(await question).toBe("/status");
    } finally { console.close(); }
  });

  test("closing input preserves a partially answered approval batch", async () => {
    const { input, console } = fixture();
    const approvals = [{ id: "one", provider: "mock", name: "apply_patch", arguments: "{}" },
      { id: "two", provider: "mock", name: "apply_patch", arguments: "{}" }] as never;
    const result = resolveTerminalApprovals(approvals, { ask: (prompt) => console.question(prompt), write: () => {} });
    input.write("y\n");
    await new Promise((resolve) => setImmediate(resolve));
    console.close();
    expect(await result).toBeUndefined();
  });

  test("completes only known console command prefixes", () => {
    expect(completeConsoleCommand("/att")).toEqual([["/attach", "/attachments"], "/att"]);
    expect(completeConsoleCommand("fix")[0]).toEqual([]);
  });

  test("Ctrl+C discards a draft and partial busy input cannot become approval", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const console = new ConsoleInput(input, output, true);
    let interruptions = 0;
    console.onInterrupt = () => { interruptions++; };
    try {
      const draft = console.multiline();
      input.write("unfinished\x03");
      await expect(draft).rejects.toMatchObject({ name: "AbortError" });
      expect(interruptions).toBe(1);
      input.write("y");
      const approval = console.question("Approve? ");
      input.write("n\n");
      expect(await approval).toBe("n");
    } finally { console.close(); }
  });

  test("recalls prompt history only in task input and clears it on session switches", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const console = new ConsoleInput(input, output, true);
    try {
      console.rememberPrompt("inspect files");
      const task = console.question("> ", true);
      input.write("\u001b[A\n");
      expect(await task).toBe("inspect files");
      const approval = console.question("Approve? ");
      input.write("\u001b[A\n");
      expect(await approval).toBe("");
      console.clearHistory();
      const next = console.question("> ", true);
      input.write("\u001b[A\n");
      expect(await next).toBe("");
    } finally { console.close(); }
  });

  test("Alt+Enter edits a multiline task without submitting it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const console = new ConsoleInput(input, output, true);
    try {
      const task = console.question("> ", true);
      input.write("first");
      input.write("\u001b\r");
      input.write("second\n");
      expect(await task).toBe("first\nsecond");
    } finally { console.close(); }
  });
});
