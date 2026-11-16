import { sanitizeTerminalText } from "./terminal-ui.js";
import { isTableSeparator, renderTerminalTable, tableCells } from "./terminal-table.js";

/** Small streaming Markdown renderer. Formatting survives pauses between tokens. */
export class TerminalMarkdown {
  private pending = "";
  private code = false;
  private heading = false;
  private lineStart = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tableLines: string[] = [];
  constructor(private readonly output: (text: string) => void, private readonly color: boolean,
    private readonly columns: () => number = () => 80) {}

  private drain(final = false) {
    let rendered = "", activeStyle = 0;
    const emit = (text: string, style = this.code ? 36 : this.heading ? 1 : 0) => {
      if (this.color && style !== activeStyle) {
        if (activeStyle) rendered += "\x1b[0m";
        if (style) rendered += `\x1b[${style}m`;
        activeStyle = style;
      }
      rendered += text;
    };
    const finishTable = () => {
      if (!this.tableLines.length) return;
      emit(this.tableLines.length > 1
        ? renderTerminalTable(this.tableLines, this.columns(), this.color)
        : this.tableLines[0]!, 0);
      this.tableLines = [];
    };
    while (this.pending) {
      if (!final && this.pending.length === 1 && /[\uD800-\uDBFF]/.test(this.pending)) break;
      if (this.lineStart) {
        if (!this.code && (this.pending.startsWith("|") || this.tableLines.length)) {
          const end = this.pending.indexOf("\n");
          // Only possible table rows wait for a full line. Prose still streams.
          if (this.pending.startsWith("|") && end < 0 && !final && this.pending.length < 8192) break;
          const line = this.pending.slice(0, end < 0 ? this.pending.length : end + 1);
          const count = this.tableLines.length ? tableCells(this.tableLines[0]!).length : 0;
          const accepted = (end >= 0 || final) && this.pending.startsWith("|") && line.length <= 8192 &&
            (this.tableLines.length === 0 ? tableCells(line).length > 0 :
              this.tableLines.length === 1 ? isTableSeparator(line, count) : tableCells(line).length === count);
          if (accepted && this.tableLines.length < 128) {
            this.tableLines.push(line); this.pending = this.pending.slice(line.length);
            continue;
          }
          finishTable();
        }
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
          if (heading) {
            this.heading = true;
            this.pending = this.pending.slice(heading[0].length);
            this.lineStart = false;
            // Recheck empty buffers and split Unicode after consuming the prefix.
            continue;
          }
        }
        this.lineStart = false;
      }
      if (this.pending[0] === "\n") {
        emit("\n", 0); this.pending = this.pending.slice(1);
        this.lineStart = true; this.heading = false; continue;
      }
      if (this.color && !this.code) {
        if (this.pending === "*" && !final) break;
        const marker = this.pending.startsWith("**") ? "**" : this.pending[0] === "`" ? "`" : undefined;
        if (marker) {
          const end = this.pending.indexOf(marker, marker.length);
          const newline = this.pending.indexOf("\n");
          if (end > marker.length && (newline < 0 || end < newline)) {
            emit(this.pending.slice(marker.length, end), marker === "`" ? 36 : 1);
            this.pending = this.pending.slice(end + marker.length);
            continue;
          }
          // Hold only a bounded candidate span. Interrupted/unmatched syntax is
          // emitted literally at flush, newline or the size cap, never lost.
          if (!final && newline < 0 && this.pending.length < 2048) break;
          emit(marker); this.pending = this.pending.slice(marker.length); continue;
        }
      }
      const point = String.fromCodePoint(this.pending.codePointAt(0)!);
      emit(point); this.pending = this.pending.slice(point.length);
    }
    if (final) finishTable();
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
