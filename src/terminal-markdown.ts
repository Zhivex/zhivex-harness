import { sanitizeTerminalText } from "./terminal-ui.js";

/** Bounded, line-oriented presentation; never emits terminal controls from model text. */
export class TerminalMarkdown {
  private pending = "";
  private code = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly output: (text: string) => void, private readonly color: boolean) {}
  private style(text: string, color: number) {
    return this.color ? `\u001b[${color}m${text}\u001b[0m` : text;
  }
  private line(raw: string) {
    const text = sanitizeTerminalText(raw);
    if (/^\s*```/.test(text)) {
      this.code = !this.code;
      return this.style(text, 90);
    }
    if (this.code) return this.style(text, 36);
    if (/^#{1,6} /.test(text)) return this.style(text.replace(/^#{1,6} /, ""), 1);
    if (!this.color) return text;
    return text.replace(/`([^`\n]+)`/g, (_match, code: string) => this.style(code, 36))
      .replace(/\*\*([^*\n]+)\*\*/g, (_match, bold: string) => this.style(bold, 1));
  }
  write(delta: string) {
    this.pending += delta;
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      this.output(`${this.line(this.pending.slice(0, index))}\n`);
      this.pending = this.pending.slice(index + 1);
    }
    if (this.pending.length >= 2048) this.flush();
    // Deliver text even when the provider pauses in the middle of a line.
    if (this.pending && !this.timer) {
      this.timer = setTimeout(() => this.flush(), 50);
      this.timer.unref();
    }
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) this.output(this.line(this.pending));
    this.pending = "";
  }
}
