import { createInterface, type Interface, type Key } from "node:readline";
import { PassThrough, type Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { sanitizeTerminalText } from "../terminal/terminal-ui.js";

import { CONSOLE_SHORTCUTS, consoleLabel, chooseConsoleItem } from "./console-presentation.js";
import { consoleCommands, searchConsoleCommands, type ConsoleMode } from "./console-commands.js";

export const CONSOLE_COMMANDS = consoleCommands().map(([name]) => name);
export const MAX_CONSOLE_INPUT_BYTES = 64 * 1024;

export const completeConsoleCommand = (line: string): [string[], string] => [
  CONSOLE_COMMANDS.filter((command) => command.startsWith(line)), line
];

const interrupted = () => Object.assign(new Error("Input interrupted."), { name: "AbortError" });

/** Lines received without an active question are discarded, never replayed as approvals. */
export class ConsoleInput {
  private hidden: { value: string; escape: string; pasted: boolean; resolve(value: string): void; reject(error: Error): void } | undefined;
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

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly terminal = true, private readonly mode: ConsoleMode = "direct") {
    // Filter before readline: bracketed paste must never be interpreted as keys.
    const source = terminal ? this.keyboard : input;
    this.display = new Writable({ write: (chunk, encoding, callback) => {
      // The destination already queues writes. Waiting for its completion here
      // creates a second queue: direct menu output can then overtake readline's
      // pending clear-screen/prompt chunks and be erased on the first render.
      output.write(chunk, encoding);
      callback();
    } });
    Object.defineProperty(this.display, "columns", {
      get: () => (output as Writable & { columns?: number }).columns
    });
    Object.assign(this.keyboard, { isTTY: terminal, setRawMode: (enabled: boolean) => {
      (input as Readable & { setRawMode?: (enabled: boolean) => void }).setRawMode?.(enabled);
    } });
    this.reader = createInterface({ input: source, output: terminal ? this.display : output, terminal, historySize: 0,
      completer: (line: string) => this.pending && this.completeCommands
        ? [consoleCommands(this.mode).map(([name]) => name).filter(name => name.startsWith(line)), line] : [[], line] });
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
      this.finishSecret(false);
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

  private selection: { title: string; items: readonly {label: string; detail?: string}[] } | undefined;
  private selectionMatches() {
    const query = this.reader.line.toLowerCase();
    return this.selection?.items.map((item, index) => ({...item, index}))
      .filter(item => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query)) ?? [];
  }
  private finishSelection(accept: boolean) {
    const selected = accept ? this.selectionMatches()[this.menuSelection] : undefined;
    this.hideMenu();
    const pending = this.pending;
    this.pending = undefined;
    this.draftWasPaste = false;
    this.reader.setPrompt("");
    this.output.write("\n");
    pending?.resolve(selected ? String(selected.index) : "");
  }
  async select<T>(title: string, items: readonly {value: T; label: string; detail?: string}[]): Promise<T | undefined> {
    if (!items.length) { this.output.write("No matches.\n"); return undefined; }
    if (!this.terminal || process.env.TERM === "dumb") return chooseConsoleItem(title, items, {
      write: text => { this.output.write(text); }, ask: prompt => this.question(prompt),
    });
    this.selection = {title, items};
    this.menuSelection = 0;
    try {
      this.output.write(`\n${sanitizeTerminalText(title)}\n`);
      const answer = this.question("Filter > ", true);
      this.renderMenu();
      const value = await answer;
      return value === "" ? undefined : items[Number(value)]?.value;
    } finally { this.hideMenu(); this.selection = undefined; }
  }
  private taskPrompt = "";
  private shortcutsShown = false;
  private historySearch: { draft: string; cursor: number; literal: boolean } | undefined;
  private historyMatches() {
    const query = this.reader.line.toLowerCase();
    return this.history.filter(entry => entry.text.toLowerCase().includes(query));
  }
  private finishHistorySearch(accept: boolean) {
    const saved = this.historySearch;
    if (!saved) return;
    const selected = accept ? this.historyMatches()[this.menuSelection] : undefined;
    this.hideMenu();
    this.historySearch = undefined;
    const line = selected?.text ?? saved.draft;
    this.draftWasPaste = selected?.literal ?? saved.literal;
    Object.assign(this.reader, { line, cursor: selected ? line.length : saved.cursor });
    this.reader.setPrompt(this.taskPrompt);
    this.reader.prompt(true);
    this.menuDismissed = true;
  }
  private menuVisible = false;
  private menuSelection = 0;
  private menuQuery = "";
  private menuDismissed = false;
  private escapeMenuTimer: ReturnType<typeof setTimeout> | undefined;
  private standaloneMenuEscape = false;

  private hideMenu() {
    if (this.menuVisible) this.output.write("\u001b7\n\r\u001b[J\u001b8");
    this.menuVisible = false;
  }

  private renderMenu() {
    this.hideMenu();
    const query = this.reader.line;
    if (query !== this.menuQuery) {
      this.menuQuery = query;
      this.menuSelection = 0;
      this.menuDismissed = false;
    }
    if (!this.terminal || process.env.TERM === "dumb" || !this.pending || !this.completeCommands ||
        (!this.selection && !this.historySearch && (this.draftWasPaste || this.menuDismissed || !/^\/[^\s]*$/.test(query)))) return;
    const matches: readonly (readonly [string, string])[] = this.selection
      ? this.selectionMatches().map(item => [item.label, item.detail ?? ""] as const)
      : this.historySearch
      ? this.historyMatches().map(entry => [consoleLabel(entry.text, 64), ""] as const)
      : searchConsoleCommands(query, this.mode).map(([name, description]) => [name, description] as const);
    if (!matches.length && !this.historySearch && !this.selection) return;
    this.menuSelection = Math.max(0, Math.min(this.menuSelection, matches.length - 1));
    const rows = (this.output as Writable & { rows?: number }).rows ?? 24;
    if (rows < 6) return;
    const pageSize = Math.min(5, rows - 4);
    const start = Math.floor(this.menuSelection / pageSize) * pageSize;
    const columns = Math.max(10, (this.output as Writable & { columns?: number }).columns ?? 80);
    const lines = matches.slice(start, start + pageSize).map(([name, description], i) =>
      `${i + start === this.menuSelection ? ">" : " "} ${name.padEnd(14)} ${description}`.slice(0, columns - 1));
    if (!matches.length) lines.push("  No matches; edit the filter".slice(0, columns - 1));
    lines.push((this.selection ? "  ↑↓ navigate · Enter choose · Esc back" : this.historySearch ? "  ↑↓ select · Enter restore · Esc cancel" :
      `  ${this.menuSelection + 1}/${matches.length} · ↑↓ select · Tab insert · Esc close`).slice(0, columns - 1));
    // Reserve space before saving the cursor, including at the bottom of a PTY.
    const column = this.reader.getCursorPos().cols;
    this.output.write("\n".repeat(lines.length) + `\u001b[${lines.length}A\u001b[${column + 1}G`);
    this.output.write("\u001b7" + lines.map(line => "\r\n" + line).join("") + "\u001b8");
    this.menuVisible = true;
  }

  private readonly onEnd = () => { this.finishSecret(false); this.keyboard.end(); };
  // Readline must not erase model output to redraw an empty prompt while busy.
  private readonly onResize = () => {
    if (this.pending || this.paste) { this.hideMenu(); this.display.emit("resize"); this.renderMenu(); }
  };

  private finishSecret(accept: boolean) {
    const hidden = this.hidden;
    if (!hidden) return;
    this.hidden = undefined;
    this.output.write("\n");
    const value = hidden.value;
    hidden.value = "";
    if (accept) hidden.resolve(value); else hidden.reject(interrupted());
  }

  secret(prompt: string): Promise<string> {
    if (!this.terminal || this.closed || this.pending || this.paste || this.hidden) {
      return Promise.reject(new Error("API key entry requires an idle interactive terminal."));
    }
    this.hideMenu();
    Object.assign(this.reader, { line: "", cursor: 0 });
    this.escape = "";
    this.output.write(prompt);
    return new Promise((resolve, reject) => { this.hidden = { value: "", escape: "", pasted: false, resolve, reject }; });
  }

  private readonly onData = (chunk: Buffer | string) => {
    if (this.hidden) {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      for (const character of text) {
        const hidden = this.hidden;
        if (!hidden) break; // Discard surplus input; it cannot answer the next question.
        if (character === "\u0003" || character === "\u0004") { this.finishSecret(false); break; }
        if (character === "\u001b" || hidden.escape) {
          hidden.escape += character;
          const marker = hidden.pasted ? "\u001b[201~" : "\u001b[200~";
          if (!marker.startsWith(hidden.escape)) { this.finishSecret(false); break; }
          if (hidden.escape === marker) { hidden.pasted = !hidden.pasted; hidden.escape = ""; }
          continue;
        }
        if (!hidden.pasted && (character === "\r" || character === "\n")) { this.finishSecret(true); break; }
        if (!hidden.pasted && (character === "\u007f" || character === "\b")) { hidden.value = hidden.value.slice(0, -1); continue; }
        if (!/^[\x21-\x7e]$/.test(character) || hidden.value.length >= 8192) { this.finishSecret(false); break; }
        hidden.value += character;
      }
      return;
    }
    clearTimeout(this.escapeMenuTimer);
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (const character of text) {
      // Keep a delayed bracketed-paste introducer intact. Ordinary typing after
      // a standalone Escape must not become a readline Meta-key chord.
      if (this.standaloneMenuEscape) {
        if (character !== "[") this.escape = "";
        this.standaloneMenuEscape = false;
      }
      if (character === "\u0003") {
        if (this.selection) { this.escape = ""; this.finishSelection(false); continue; }
        this.escape = "";
        this.clipboard = undefined;
        this.interrupt();
        continue;
      }
      this.escape += character;
      const marker = this.clipboard === undefined ? "\u001b[200~" : "\u001b[201~";
      if (marker.startsWith(this.escape)) {
        if (this.escape !== marker) {
          if (this.escape === "\u001b" && (this.menuVisible || this.historySearch || this.selection)) {
            this.escapeMenuTimer = setTimeout(() => {
              if (this.escape !== "\u001b") return;
              if (this.selection) this.finishSelection(false);
              else if (this.historySearch) this.finishHistorySearch(false);
              this.hideMenu();
              this.menuDismissed = true;
              this.standaloneMenuEscape = true;
            }, 100);
          }
          continue;
        }
        this.escape = "";
        if (this.clipboard === undefined) {
          this.hideMenu();
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
      } else if (this.pending || this.paste) {
        this.hideMenu();
        if (this.selection && !/[\u0000-\u001f\u007f]/.test(plain) &&
            Buffer.byteLength(this.reader.line) + Buffer.byteLength(plain) > MAX_CONSOLE_INPUT_BYTES) continue;
        if (this.selection && (plain === "\n" || plain === "\r")) {
          if (this.selectionMatches().length) this.finishSelection(true);
        } else if (plain === "?" && !this.selection && this.pending && this.completeCommands && !this.historySearch && !this.reader.line && !this.shortcutsShown) {
          this.shortcutsShown = true;
          this.output.write("\n" + CONSOLE_SHORTCUTS + "\n");
          this.reader.prompt(true);
        } else {
          const matches = this.pending && this.completeCommands && !this.historySearch && !this.draftWasPaste &&
            !this.menuDismissed && /^\/[^\s]*$/.test(this.reader.line) ? searchConsoleCommands(this.reader.line, this.mode) : [];
          const selected = matches[this.menuSelection % Math.max(1, matches.length)]?.[0];
          if ((plain === "\n" || plain === "\r") && selected && selected !== this.reader.line) {
            // Complete a selection, then require a separate submission. Consume
            // the raw newline so it cannot enter the draft on alternate runtimes.
            Object.assign(this.reader, { line: selected + " ", cursor: selected.length + 1 });
            this.reader.prompt(true);
          } else this.keyboard.write(plain);
        }
        this.renderMenu();
      }
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
    if (this.selection) {
      if (["up", "down", "tab"].includes(key.name ?? "")) {
        const previous = key.name === "up";
        key.name = "console-select"; key.meta = true;
        const count = Math.max(1, this.selectionMatches().length);
        this.menuSelection = (this.menuSelection + (previous ? -1 : 1) + count) % count;
      } else if (key.ctrl && key.name === "r") { key.name = "console-select"; key.ctrl = false; key.meta = true; }
      return;
    }
    if (key.ctrl && key.name === "r") {
      key.name = "console-search"; key.ctrl = false; key.meta = true;
      if (!this.historySearch) {
        this.historySearch = { draft: this.reader.line, cursor: this.reader.cursor, literal: this.draftWasPaste };
        this.draftWasPaste = false;
        this.menuSelection = 0;
        Object.assign(this.reader, { line: "", cursor: 0 });
        this.reader.setPrompt("history > ");
        this.reader.prompt(true);
      } else this.menuSelection = (this.menuSelection + 1) % Math.max(1, this.historyMatches().length);
      return;
    }
    if (this.historySearch && ["return", "enter", "tab", "up", "down"].includes(key.name ?? "")) {
      const name = key.name;
      key.name = "console-search"; key.meta = true;
      if (["return", "enter", "tab"].includes(name!)) this.finishHistorySearch(true);
      else {
        const count = Math.max(1, this.historyMatches().length);
        this.menuSelection = (this.menuSelection + (name === "up" ? -1 : 1) + count) % count;
      }
      return;
    }
    const menu = !this.historySearch && !this.draftWasPaste && !this.menuDismissed && /^\/[^\s]*$/.test(this.reader.line)
      ? searchConsoleCommands(this.reader.line, this.mode) : [];
    if (menu.length && ["up", "down", "tab", "escape"].includes(key.name ?? "")) {
      const name = key.name;
      key.name = "console-menu";
      key.meta = true;
      if (name === "escape") this.menuDismissed = true;
      else if (name === "tab") {
        const selected = menu[this.menuSelection % menu.length]![0];
        Object.assign(this.reader, { line: selected + " ", cursor: selected.length + 1 });
        this.reader.prompt(true);
      } else this.menuSelection = (this.menuSelection + (name === "up" ? -1 : 1) + menu.length) % menu.length;
      return;
    }
    if (_text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(_text) &&
        Buffer.byteLength(this.reader.line) + Buffer.byteLength(_text) > MAX_CONSOLE_INPUT_BYTES) {
      key.name = "console-input-limit";
      key.meta = true;
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const previous = key.name === "up";
      const line = this.reader.line;
      const cursor = this.reader.cursor;
      const lineStart = line.lastIndexOf("\n", cursor - 1) + 1;
      const lineEnd = line.indexOf("\n", cursor);
      if ((previous && lineStart > 0) || (!previous && lineEnd >= 0)) {
        key.name = "console-cursor"; key.meta = true;
        const column = cursor - lineStart;
        const targetStart = previous ? line.lastIndexOf("\n", lineStart - 2) + 1 : lineEnd + 1;
        const targetEnd = line.indexOf("\n", targetStart);
        const target = Math.min(targetStart + column, targetEnd < 0 ? line.length : targetEnd);
        Object.assign(this.reader, { line, cursor: target });
        this.reader.prompt(true);
        return;
      }
      key.name = "console-history";
      key.meta = true;
      if (this.historyPosition === -1) {
        this.historyDraft = this.reader.line;
        this.historyDraftWasPaste = this.draftWasPaste;
      }
      this.historyPosition = previous ? Math.min(this.history.length - 1, this.historyPosition + 1)
        : Math.max(-1, this.historyPosition - 1);
      const entry = this.history[this.historyPosition];
      const historyLine = entry?.text ?? this.historyDraft;
      this.draftWasPaste = entry?.literal ?? this.historyDraftWasPaste;
      Object.assign(this.reader, { line: historyLine, cursor: historyLine.length });
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
    this.finishSecret(false);
    clearTimeout(this.escapeMenuTimer);
    this.standaloneMenuEscape = false;
    this.historySearch = undefined;
    this.hideMenu();
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
    if (this.pending || this.paste || this.hidden) return Promise.reject(new Error("A console question is already active."));
    clearTimeout(this.escapeMenuTimer);
    this.escape = "";
    this.standaloneMenuEscape = false;
    this.hideMenu();
    this.menuDismissed = false;
    this.menuQuery = "";
    this.completeCommands = completeCommands;
    this.taskPrompt = prompt;
    this.historySearch = undefined;
    this.shortcutsShown = false;
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
    if (this.pending || this.paste || this.hidden) return Promise.reject(new Error("A console question is already active."));
    return new Promise((resolve, reject) => {
      this.paste = { lines: [], bytes: 0, resolve, reject };
      this.reader.setPrompt("");
      this.output.write("Paste text; finish with .end on its own line. Ctrl+C discards the draft.\n");
    });
  }

  close() {
    this.finishSecret(false);
    clearTimeout(this.escapeMenuTimer);
    this.hideMenu();
    (this.terminal ? this.keyboard : this.input).off("keypress", this.onKeypress);
    this.clearHistory();
    this.reader.close();
  }
}
