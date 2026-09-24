import { sanitizeTerminalText } from "./terminal-ui.js";

/** Small streaming Markdown renderer. Formatting survives pauses between tokens. */
export class TerminalMarkdown {
  private pending = "";
  private code = false;
  private inlineCode = false;
  private bold = false;
  private heading = false;
  private lineStart = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly output: (text: string) => void, private readonly color: boolean) {}

  private drain(final = false) {
    let rendered = "", activeStyle = 0;
    const emit = (text: string, style = this.code || this.inlineCode ? 36 : this.bold || this.heading ? 1 : 0) => {
      if (this.color && style !== activeStyle) {
        if (activeStyle) rendered += "\x1b[0m";
        if (style) rendered += `\x1b[${style}m`;
        activeStyle = style;
      }
      rendered += text;
    };
    while (this.pending) {
      if (!final && this.pending.length === 1 && /[\uD800-\uDBFF]/.test(this.pending)) break;
      if (this.lineStart) {
        // Keep only ambiguous line prefixes, never a whole prose line.
        if (!final && (/^`{1,2}$/.test(this.pending) || /^#{1,6}$/.test(this.pending))) break;
        if (this.pending.startsWith("```")) {
          const end = this.pending.indexOf("\n");
          if (end < 0 && !final && this.pending.length < 128) break;
          const length = end < 0 ? this.pending.length : end;
          emit(this.pending.slice(0, length), 90);
          this.pending = this.pending.slice(length);
          this.code = !this.code;
          this.lineStart = false;
          continue;
        }
        if (!this.code) {
          const heading = /^#{1,6} /.exec(this.pending);
          if (heading) { this.heading = true; this.pending = this.pending.slice(heading[0].length); }
        }
        this.lineStart = false;
      }
      if (this.pending[0] === "\n") {
        emit("\n", 0); this.pending = this.pending.slice(1);
        this.lineStart = true; this.heading = false; continue;
      }
      if (this.color && !this.code) {
        if (!this.inlineCode && this.pending === "*" && !final) break;
        if (!this.inlineCode && this.pending.startsWith("**")) {
          this.bold = !this.bold; this.pending = this.pending.slice(2); continue;
        }
        if (this.pending[0] === "`") {
          this.inlineCode = !this.inlineCode; this.pending = this.pending.slice(1); continue;
        }
      }
      const point = String.fromCodePoint(this.pending.codePointAt(0)!);
      emit(point); this.pending = this.pending.slice(point.length);
    }
    if (activeStyle) rendered += "\x1b[0m";
    if (rendered) this.output(rendered);
  }
  write(delta: string) {
    this.pending += sanitizeTerminalText(delta);
    if (this.pending.includes("\n") || this.pending.length >= 2048) this.drain();
    // Coalesce token bursts into a frame, without waiting for a sentence/newline.
    if (this.pending && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 24);
      this.timer.unref();
    }
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    this.drain(true);
  }
}
