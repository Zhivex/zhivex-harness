import { createInterface, type Interface, type Key } from "node:readline";
import { PassThrough, type Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { sanitizeTerminalText } from "./terminal-ui.js";

export const CONSOLE_COMMANDS = [
  "/help", "/provider", "/model", "/route", "/status", "/diff", "/review",
  "/resume", "/pending", "/approve", "/deny", "/compact", "/new", "/rename",
  "/clear", "/exit", "/paste", "/context", "/attach", "/attachments", "/detach", "/sessions", "/usage"
] as const;
export const MAX_CONSOLE_INPUT_BYTES = 64 * 1024;

export const completeConsoleCommand = (line: string): [string[], string] => [
  CONSOLE_COMMANDS.filter((command) => command.startsWith(line)), line
];

const interrupted = () => Object.assign(new Error("Input interrupted."), { name: "AbortError" });

/** Lines received without an active question are discarded, never replayed as approvals. */
export class ConsoleInput {
  private readonly reader: Interface;
  private readonly keyboard = new PassThrough();
  private readonly display: Writable;
  private readonly decoder = new StringDecoder("utf8");
  private escape = "";
  private clipboard: string | undefined;
  private clipboardBytes = 0;
  private clipboardAllowed = false;
  private draftWasPaste = false;
  lastSubmissionWasPaste = false;
  private closed = false;
  private completeCommands = false;
  private history: { text: string; literal: boolean }[] = [];
  private historyPosition = -1;
  private historyDraft = "";
  private historyDraftWasPaste = false;
  private pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  private paste: { lines: string[]; bytes: number; resolve(value: string): void; reject(error: Error): void } | undefined;
  onInterrupt: (() => void) | undefined;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly terminal = true) {
    // Filter before readline: bracketed paste must never be interpreted as keys.
    const source = terminal ? this.keyboard : input;
    this.display = new Writable({ write: (chunk, encoding, callback) => {
      output.write(chunk, encoding, callback);
    } });
    Object.defineProperty(this.display, "columns", {
      get: () => (output as Writable & { columns?: number }).columns
    });
    Object.assign(this.keyboard, { isTTY: terminal, setRawMode: (enabled: boolean) => {
      (input as Readable & { setRawMode?: (enabled: boolean) => void }).setRawMode?.(enabled);
    } });
    this.reader = createInterface({ input: source, output: terminal ? this.display : output, terminal, historySize: 0,
      completer: (line: string) => this.pending && this.completeCommands
        ? completeConsoleCommand(line) : [[], line] });
    this.reader.setPrompt("");
    source.prependListener("keypress", this.onKeypress);
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
      this.lastSubmissionWasPaste = this.draftWasPaste;
      this.draftWasPaste = false;
      this.reader.setPrompt("");
      if (Buffer.byteLength(line) > MAX_CONSOLE_INPUT_BYTES) {
        pending?.reject(new Error("Input exceeds 64 KiB."));
      } else pending?.resolve(line);
    });
    this.reader.on("SIGINT", () => this.interrupt());
    this.reader.on("close", () => {
      this.closed = true;
      if (terminal) {
        output.write("\u001b[?2004l");
        input.off("data", this.onData);
        input.off("end", this.onEnd);
        output.off("resize", this.onResize);
        input.pause();
      }
      this.interrupt();
    });
    if (terminal) {
      output.write("\u001b[?2004h");
      input.on("data", this.onData);
      input.on("end", this.onEnd);
      output.on("resize", this.onResize);
      input.resume();
    }
  }

  private readonly onEnd = () => { this.keyboard.end(); };
  // Readline must not erase model output to redraw an empty prompt while busy.
  private readonly onResize = () => {
    if (this.pending || this.paste) this.display.emit("resize");
  };

  private readonly onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (const character of text) {
      if (character === "\u0003") {
        this.escape = "";
        this.clipboard = undefined;
        this.interrupt();
        continue;
      }
      this.escape += character;
      const marker = this.clipboard === undefined ? "\u001b[200~" : "\u001b[201~";
      if (marker.startsWith(this.escape)) {
        if (this.escape !== marker) continue;
        this.escape = "";
        if (this.clipboard === undefined) {
          this.clipboard = "";
          this.clipboardBytes = 0;
          this.clipboardAllowed = Boolean(this.pending && this.completeCommands) || Boolean(this.paste);
        } else {
          const clipboard = this.clipboard;
          this.clipboard = undefined;
          if (this.clipboardAllowed && this.clipboardBytes <= MAX_CONSOLE_INPUT_BYTES) {
            const safe = sanitizeTerminalText(clipboard.replace(/\r\n?/g, "\n"));
            if (this.paste) {
              if (this.paste.bytes + Buffer.byteLength(safe) + 1 <= MAX_CONSOLE_INPUT_BYTES) {
                this.paste.lines.push(safe);
                this.paste.bytes += Buffer.byteLength(safe) + 1;
                this.output.write(safe + "\n");
              } else this.output.write("\nPaste exceeds 64 KiB; clipboard discarded.\n");
            } else if (this.pending && this.completeCommands) {
              this.insert(safe);
              this.draftWasPaste = true;
            }
          } else if (this.clipboardAllowed) this.output.write("\nPaste exceeds 64 KiB; clipboard discarded.\n");
          // A send/approval appended to the same clipboard packet is not a fresh key.
          return;
        }
        continue;
      }
      const plain = this.escape;
      this.escape = "";
      if (this.clipboard !== undefined) {
        this.clipboardBytes += Buffer.byteLength(plain);
        if (this.clipboardAllowed && this.clipboardBytes <= MAX_CONSOLE_INPUT_BYTES) this.clipboard += plain;
      } else if (this.pending || this.paste) this.keyboard.write(plain);
    }
  };

  private insert(text: string) {
    const line = this.reader.line;
    if (Buffer.byteLength(line) + Buffer.byteLength(text) > MAX_CONSOLE_INPUT_BYTES) {
      this.output.write("\nInput exceeds 64 KiB; insertion discarded.\n");
    } else {
      const cursor = this.reader.cursor;
      Object.assign(this.reader, { line: line.slice(0, cursor) + text + line.slice(cursor), cursor: cursor + text.length });
    }
    this.reader.prompt(true);
  }

  private readonly onKeypress = (_text: string, key: Key) => {
    if (!this.pending || !this.completeCommands) return;
    if (_text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(_text) &&
        Buffer.byteLength(this.reader.line) + Buffer.byteLength(_text) > MAX_CONSOLE_INPUT_BYTES) {
      key.name = "console-input-limit";
      key.meta = true;
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const previous = key.name === "up";
      key.name = "console-history";
      key.meta = true;
      if (this.historyPosition === -1) {
        this.historyDraft = this.reader.line;
        this.historyDraftWasPaste = this.draftWasPaste;
      }
      this.historyPosition = previous ? Math.min(this.history.length - 1, this.historyPosition + 1)
        : Math.max(-1, this.historyPosition - 1);
      const entry = this.history[this.historyPosition];
      const line = entry?.text ?? this.historyDraft;
      this.draftWasPaste = entry?.literal ?? this.historyDraftWasPaste;
      Object.assign(this.reader, { line, cursor: line.length });
      this.reader.prompt(true);
      return;
    }
    if (!key.meta || (key.name !== "return" && key.name !== "enter")) return;
    // Consume the modified key before readline can submit it (including Bun).
    key.name = "console-newline";
    this.insert("\n");
  };

  rememberPrompt(prompt: string, literal = false) {
    if (!prompt.trim() || (!literal && prompt.startsWith("/")) || Buffer.byteLength(prompt) > MAX_CONSOLE_INPUT_BYTES) return;
    this.history = [{ text: prompt, literal }, ...this.history.filter((entry) => entry.text !== prompt)].slice(0, 100);
    while (this.history.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0) > 256 * 1024) this.history.pop();
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
    this.draftWasPaste = false;
    this.reader.setPrompt("");
    if (this.terminal) Object.assign(this.reader, { line: "", cursor: 0 });
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
    (this.terminal ? this.keyboard : this.input).off("keypress", this.onKeypress);
    this.clearHistory();
    this.reader.close();
  }
}
