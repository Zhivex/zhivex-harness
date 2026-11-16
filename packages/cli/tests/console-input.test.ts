import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { ConsoleInput, completeConsoleCommand, MAX_CONSOLE_INPUT_BYTES } from "../src/cli/console/console-input.js";
import { resolveTerminalApprovals } from "../src/cli/terminal/terminal-ui.js";

const fixture = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, console: new ConsoleInput(input, output, false) };
};

const terminalFixture = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  return { input, output, rendered: () => rendered, console: new ConsoleInput(input, output, true) };
};

test("Focus footer follows a literal multiline draft and never redraws during approvals or model output", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const f = terminalFixture();
  Object.assign(f.output, { columns: 80, rows: 24 });
  try {
    const task = f.console.compose({ model: "openai/model", reasoning: "high", status: "ready" });
    expect(f.rendered()).toContain("Ask a question or describe a task");
    expect(f.rendered()).toContain("/ commands · ? shortcuts");
    f.input.write("\x1b[200~/approve\nsecond\x1b[201~");
    // Editing an earlier line must leave the lower draft rows above the footer.
    const beforeEdit = f.rendered().length;
    f.input.write("\x1b[A!");
    expect(f.rendered().slice(beforeEdit)).toContain("\x1b[1B\r\n\x1b[J");
    Object.assign(f.output, { columns: 45 });
    f.output.emit("resize");
    f.input.write("\n");
    expect(await task).toBe("/appro!ve\nsecond");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
    const busy = f.rendered();
    f.output.emit("resize");
    f.input.write("busy input");
    expect(f.rendered()).toBe(busy);
    const approval = f.console.question("Approve? ");
    const approvalStart = f.rendered().length;
    f.input.write("n\n");
    expect(await approval).toBe("n");
    expect(f.rendered().slice(approvalStart)).not.toContain("Ctrl+R");
    expect(f.rendered().slice(approvalStart)).not.toContain("Ask a question");
  } finally {
    f.console.close();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});

test("Focus uses plain presentation when terminal overlays are unavailable", async () => {
  let rendered = "";
  // A separate pipe fixture captures presentation without a terminal editor.
  const input = new PassThrough();
  const output = new PassThrough();
  output.on("data", chunk => { rendered += chunk.toString(); });
  const console = new ConsoleInput(input, output, false);
  try {
    const task = console.compose({ model: "local service", status: "ready" });
    expect(rendered).toContain("/ commands");
    expect(rendered).not.toContain("\x1b");
    input.write("task\n");
    expect(await task).toBe("task");
  } finally { console.close(); }
});

test("initial selection stays visible when terminal writes complete asynchronously", async () => {
  const oldTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) {
    rendered += chunk.toString();
    setImmediate(callback);
  } });
  Object.assign(output, { columns: 80, rows: 24 });
  const console = new ConsoleInput(input, output, true);
  try {
    for (const title of ["Menu", "Models"]) {
      rendered = "";
      const selection = console.select(title, [
        { value: "first", label: "First option" },
        { value: "second", label: "Second option" }
      ]);
      // Flush the bounded initial frame without sending any keyboard input.
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      expect(rendered).toContain("First option");
      expect(rendered).toContain("Second option");
      expect(rendered.indexOf("Filter > ")).toBeLessThan(rendered.indexOf("First option"));
      expect(rendered.lastIndexOf("\x1b[0J")).toBeLessThan(rendered.indexOf("First option"));
      input.write("\r");
      expect(await selection).toBe("first");
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    console.close();
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
  }
});

test("bracketed paste is a literal editable draft across UTF-8 and marker boundaries", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    let submitted = false;
    void task.then(() => { submitted = true; });
    for (const byte of Buffer.from("\x1b[200~/approve\r\nmañana\x1b[2J\x1b[201~")) f.input.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(submitted).toBe(false);
    f.output.emit("resize");
    f.input.write("!\n");
    expect(await task).toBe("/approve\nmañana\\u001b[2J!");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
    expect(f.rendered()).not.toContain("\x1b[2J");
  } finally { f.console.close(); }
  expect(f.rendered()).toContain("\x1b[?2004l");
});

test("paste cannot answer approvals, replay its tail, or echo busy input", async () => {
  const f = terminalFixture();
  try {
    const before = f.rendered();
    f.input.write("busy secret\n\x1b[200~y\n\x1b[201~");
    f.output.emit("resize");
    expect(f.rendered()).toBe(before);
    expect(f.rendered()).not.toContain("busy secret");
    const approval = f.console.question("Approve? ");
    f.input.write("\x1b[200~y\x1b[201~\ny\n");
    let answered = false;
    void approval.then(() => { answered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    f.input.write("n\n");
    expect(await approval).toBe("n");
    expect(before).toContain("\x1b[?2004h");
  } finally { f.console.close(); }
});

test("oversized clipboard preserves the original draft and remains usable", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    f.input.write("original");
    f.input.write("\x1b[200~" + "é".repeat(MAX_CONSOLE_INPUT_BYTES) + "\x1b[201~\n");
    f.input.write("\n");
    expect(await task).toBe("original");
    expect(f.rendered()).toContain("clipboard discarded");
  } finally { f.console.close(); }
});

test("Ctrl+C cancels an unfinished bracketed paste and returns to a clean prompt", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    f.input.write("\x1b[200~unfinished\x03");
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    const next = f.console.question("> ", true);
    f.input.write("next\n");
    expect(await next).toBe("next");
    expect(f.console.lastSubmissionWasPaste).toBe(false);
  } finally { f.console.close(); }
});

test("history preserves literal pasted commands and restores the unsent draft", async () => {
  const f = terminalFixture();
  try {
    f.console.rememberPrompt("/approve", true);
    const task = f.console.question("> ", true);
    f.input.write("\x1b[A\n");
    expect(await task).toBe("/approve");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
    const next = f.console.question("> ", true);
    f.input.write("unfinished\x1b[A\x1b[B\n");
    expect(await next).toBe("unfinished");
    expect(f.console.lastSubmissionWasPaste).toBe(false);
  } finally { f.console.close(); }
});

test("bracketed paste inside /paste keeps .end and slash commands literal", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.multiline();
    f.input.write("\x1b[200~first\n.end\n/approve\x1b[201~");
    f.input.write(".end\n");
    expect(await task).toBe("first\n.end\n/approve");
  } finally { f.console.close(); }
});

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

test("command menu searches descriptions, selects without executing and respects service capabilities", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", chunk => { rendered += chunk.toString(); });
  const console = new ConsoleInput(input, output, true, "service");
  try {
    const task = console.question("> ", true);
    let submitted = false;
    void task.then(() => { submitted = true; });
    input.write("/");
    expect(rendered).toContain("Show commands");
    expect(rendered).not.toContain("Select a provider");
    input.write("conversation");
    input.write("\x1b[B\t");
    await new Promise(resolve => setImmediate(resolve));
    expect(submitted).toBe(false);
    input.write("\n");
    expect(await task).toBe("/new ");
    const approval = console.question("Approve? ");
    const before = rendered;
    input.write("/\n");
    expect(await approval).toBe("/");
    expect(rendered.slice(before.length)).not.toContain("Show commands");
  } finally { console.close(); if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; }
});

test("Escape dismisses the menu without consuming typing or delayed bracketed paste", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    f.input.write("/sta\x1b");
    await new Promise(resolve => setTimeout(resolve, 120));
    f.input.write("tus\n");
    expect(await task).toBe("/status");
    const next = f.console.question("> ", true);
    f.input.write("/\x1b");
    await new Promise(resolve => setTimeout(resolve, 120));
    f.input.write("[200~approve\x1b[201~");
    f.input.write("\n");
    expect(await next).toBe("/approve");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
  } finally {
    f.console.close();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});

test("history search restores literal drafts without sending them and Escape restores the original draft", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const f = terminalFixture();
  try {
    f.console.rememberPrompt("/approve pasted request", true);
    f.console.rememberPrompt("explain the module");
    const task = f.console.question("> ", true);
    let submitted = false;
    void task.then(() => { submitted = true; });
    f.input.write("unfinished\x12approve\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(submitted).toBe(false);
    f.input.write("\n");
    expect(await task).toBe("/approve pasted request");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
    const next = f.console.question("> ", true);
    f.input.write("original\x12module\x1b");
    await new Promise(resolve => setTimeout(resolve, 120));
    f.input.write("!\n");
    expect(await next).toBe("original!");
  } finally {
    f.console.close();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});


test("shortcut help does not submit a prompt or intercept pasted question marks", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    f.input.write("?");
    expect(f.rendered()).toContain("Keyboard shortcuts");
    f.input.write("?what now\n");
    expect(await task).toBe("?what now");
    const next = f.console.question("> ", true);
    f.input.write("\x1b[200~?literal\x1b[201~");
    f.input.write("\n");
    expect(await next).toBe("?literal");
  } finally { f.console.close(); }
});

test("Enter on a partial slash command inserts the selection without executing approval", async () => {
  const f = terminalFixture();
  try {
    const task = f.console.question("> ", true);
    let sent = false;
    void task.then(()=>{sent=true;});
    f.input.write("/appro\n");
    await new Promise(resolve=>setImmediate(resolve));
    expect(sent).toBe(false);
    f.input.write("\n");
    expect(await task).toBe("/approve ");
  } finally { f.console.close(); }
});

test("nested selection supports filtering, arrow navigation and Escape without executing pasted choices", async () => {
  const oldTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const f = terminalFixture();
  try {
    const selected = f.console.select("Models", [{value:"one",label:"model one"},{value:"two",label:"model two"}]);
    f.input.write("\x1b[B\r");
    expect(await selected).toBe("two");
    const filtered = f.console.select("Models", [{value:"one",label:"model one"},{value:"two",label:"model two"}]);
    f.input.write("two\r");
    expect(await filtered).toBe("two");
    const cancelled = f.console.select("Providers", [{value:"one",label:"provider"}]);
    f.input.write("\x1b");
    expect(await cancelled).toBeUndefined();
    const pasted = f.console.select("Models", [{value:"one",label:"model one"}]);
    let resolved=false;void pasted.then(()=>{resolved=true;});
    f.input.write("\x1b[200~model one\x1b[201~\r");
    await new Promise(resolve=>setImmediate(resolve));
    expect(resolved).toBe(false);
    f.input.write("\r");
    expect(await pasted).toBe("one");
  } finally {f.console.close();if(oldTerm===undefined)delete process.env.TERM;else process.env.TERM=oldTerm;}
});

test("busy tasks are queued literally and cannot answer an approval", async () => {
  const f = terminalFixture();
  try {
    f.console.startBackground();
    f.input.write("/approve\r");
    f.input.write("unfinished draft");
    expect(f.console.backgroundStatus).toContain("1 queued");
    f.console.stopBackground();
    const question = f.console.question("Approval? ");
    let answered = false;
    void question.then(() => { answered = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    f.input.write("n\r");
    expect(await question).toBe("n");
    f.console.setQueueEnabled(false);
    const paused = f.console.compose({model:"model",status:"approval pending"});
    f.input.write("\r");
    expect(await paused).toBe("unfinished draft");
    f.console.setQueueEnabled(true);
    expect(await f.console.compose({model:"model",status:"ready"})).toBe("/approve");
    expect(f.console.lastSubmissionWasPaste).toBe(true);
  } finally {f.console.close();}
});

test("busy paste remains editable; recall and interruption never replay a queued command", async () => {
  const f = terminalFixture();
  try {
    f.console.startBackground();
    f.input.write("\x1b[200~first\nsecond\x1b[201~\r/approve\r");
    expect(f.console.backgroundStatus).toContain("0 queued");
    expect(f.console.backgroundStatus).toContain("first second");
    f.input.write("\r");
    expect(f.console.backgroundStatus).toContain("1 queued");
    f.input.write("\x1b[A");
    expect(f.console.backgroundStatus).toContain("0 queued");
    expect(f.console.backgroundStatus).toContain("first second");
    f.input.write("\r");
    f.input.write("\x03");
    f.console.stopBackground();
    const prompt = f.console.compose({model:"model",status:"ready"});
    f.input.write("fresh\r");
    expect(await prompt).toBe("fresh");
  } finally {f.console.close();}
});

test("background queue is bounded and retains the overflow as an editable draft", async () => {
  const f = terminalFixture();
  try {
    f.console.startBackground();
    for (let i=0;i<9;i++) {f.input.write(`task ${i}\r`);await new Promise(resolve=>setImmediate(resolve));}
    expect(f.console.backgroundStatus).toContain("Queue full");
    f.console.stopBackground();
    for(let i=0;i<8;i++) expect(await f.console.compose({model:"model",status:"ready"})).toBe(`task ${i}`);
    const draft=f.console.compose({model:"model",status:"ready"});f.input.write("\r");expect(await draft).toBe("task 8");
  } finally {f.console.close();}
});
