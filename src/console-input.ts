import { createInterface, type Interface, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const CONSOLE_COMMANDS = [
  "/help", "/provider", "/model", "/route", "/status", "/diff", "/review",
  "/resume", "/pending", "/approve", "/deny", "/compact", "/new", "/rename",
  "/clear", "/exit", "/paste", "/context", "/attach", "/attachments", "/detach"
] as const;
export const MAX_CONSOLE_INPUT_BYTES = 64 * 1024;

export const completeConsoleCommand = (line: string): [string[], string] => [
  CONSOLE_COMMANDS.filter((command) => command.startsWith(line)), line
];

const interrupted = () => Object.assign(new Error("Input interrupted."), { name: "AbortError" });

/** Lines received without an active question are discarded, never replayed as approvals. */
export class ConsoleInput {
  private readonly reader: Interface;
  private closed = false;
  private completeCommands = false;
  private history: string[] = [];
  private historyPosition = -1;
  private historyDraft = "";
  private pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  private paste: { lines: string[]; bytes: number; resolve(value: string): void; reject(error: Error): void } | undefined;
  onInterrupt: (() => void) | undefined;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly terminal = true) {
    this.reader = createInterface({ input, output, terminal, historySize: 0,
      completer: (line: string) => this.pending && this.completeCommands
        ? completeConsoleCommand(line) : [[], line] });
    this.reader.setPrompt("");
    input.prependListener("keypress", this.onKeypress);
    this.reader.on("line", (line) => {
      if (this.paste) {
        const paste = this.paste;
        if (line === ".end") {
          this.paste = undefined;
          paste.resolve(paste.lines.join("\n"));
        } else {
          paste.bytes += Buffer.byteLength(line) + 1;
          if (paste.bytes > MAX_CONSOLE_INPUT_BYTES) {
            this.paste = undefined;
            paste.reject(new Error("Multiline input exceeds 64 KiB; draft discarded."));
          } else paste.lines.push(line);
        }
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (Buffer.byteLength(line) > MAX_CONSOLE_INPUT_BYTES) {
        pending?.reject(new Error("Input exceeds 64 KiB."));
      } else pending?.resolve(line);
    });
    this.reader.on("SIGINT", () => this.interrupt());
    this.reader.on("close", () => {
      this.closed = true;
      this.interrupt();
    });
  }

  private readonly onKeypress = (_text: string, key: Key) => {
    if (!this.pending || !this.completeCommands) return;
    if (key.name === "up" || key.name === "down") {
      const previous = key.name === "up";
      key.name = "console-history";
      key.meta = true;
      if (this.historyPosition === -1) this.historyDraft = this.reader.line;
      this.historyPosition = previous ? Math.min(this.history.length - 1, this.historyPosition + 1)
        : Math.max(-1, this.historyPosition - 1);
      const line = this.historyPosition === -1 ? this.historyDraft : this.history[this.historyPosition]!;
      Object.assign(this.reader, { line, cursor: line.length });
      this.reader.prompt(true);
      return;
    }
    if (!key.meta || (key.name !== "return" && key.name !== "enter")) return;
    // Consume the modified key before readline can submit it (including Bun).
    key.name = "console-newline";
    const line = this.reader.line;
    const cursor = this.reader.cursor;
    if (Buffer.byteLength(line) >= MAX_CONSOLE_INPUT_BYTES) return;
    Object.assign(this.reader, { line: `${line.slice(0, cursor)}\n${line.slice(cursor)}`, cursor: cursor + 1 });
    this.reader.prompt(true);
  };

  rememberPrompt(prompt: string) {
    if (!prompt.trim() || prompt.startsWith("/") || Buffer.byteLength(prompt) > MAX_CONSOLE_INPUT_BYTES) return;
    this.history = [prompt, ...this.history.filter((entry) => entry !== prompt)].slice(0, 100);
    while (this.history.reduce((bytes, entry) => bytes + Buffer.byteLength(entry), 0) > 256 * 1024) this.history.pop();
  }

  clearHistory() {
    this.history = [];
    this.historyPosition = -1;
    this.historyDraft = "";
  }

  private interrupt() {
    this.pending?.reject(interrupted());
    this.paste?.reject(interrupted());
    this.pending = undefined;
    this.paste = undefined;
    this.onInterrupt?.();
  }

  get isClosed() { return this.closed; }

  question(prompt: string, completeCommands = false): Promise<string> {
    if (this.closed) return Promise.reject(interrupted());
    if (this.pending || this.paste) return Promise.reject(new Error("A console question is already active."));
    this.completeCommands = completeCommands;
    this.historyPosition = -1;
    this.historyDraft = "";
    // Discard an unfinished line typed while a model/tool was running.
    if (this.terminal) {
      // Node and Bun expose mutable buffers; @types/node marks their views readonly.
      // Clear both sides of the cursor, not only the prefix erased by Ctrl+U.
      Object.assign(this.reader, { line: "", cursor: 0 });
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (this.terminal) {
        this.reader.setPrompt(prompt);
        this.reader.prompt();
      } else this.output.write(prompt);
    });
  }

  multiline(): Promise<string> {
    if (this.closed) return Promise.reject(interrupted());
    if (this.pending || this.paste) return Promise.reject(new Error("A console question is already active."));
    return new Promise((resolve, reject) => {
      this.paste = { lines: [], bytes: 0, resolve, reject };
      this.reader.setPrompt("");
      this.output.write("Paste text; finish with .end on its own line. Ctrl+C discards the draft.\n");
    });
  }

  close() {
    this.input.off("keypress", this.onKeypress);
    this.clearHistory();
    this.reader.close();
  }
}
