const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (value: string) => [...segments.segment(value)].map(item => item.segment);

/** Terminal cell width, including combining marks, CJK and emoji clusters. */
export const terminalCellWidth = (value: string): number => graphemes(value).reduce((width, part) => {
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(part)) return width;
  const code = part.codePointAt(0)!;
  const wide = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(part) ||
    code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
      code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
      code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
      code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000);
  return width + (wide ? 2 : 1);
}, 0);

export function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells: string[] = [];
  let cell = "", ticks = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && text[i + 1] === "|") { cell += "|"; i++; continue; }
    if (char === "`") {
      let count = 1;
      while (text[i + count] === "`") count++;
      ticks = ticks === count ? 0 : ticks || count;
      cell += "`".repeat(count); i += count - 1; continue;
    }
    if (char === "|" && !ticks) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  if (cell.trim() || !text.endsWith("|")) cells.push(cell.trim());
  return cells;
}

export const isTableSeparator = (line: string, columns: number) => {
  const cells = tableCells(line);
  return cells.length === columns && cells.every(cell => /^:?-{3,}:?$/.test(cell));
};

const plainCell = (value: string) => value.replace(/(`+)(.*?)\1/g, "$2")
  .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\s+/g, " ").trim();

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "", used = 0;
  for (const word of value.split(" ")) {
    const size = terminalCellWidth(word);
    if (line && used + 1 + size > width) { lines.push(line); line = ""; used = 0; }
    if (line) { line += " "; used++; }
    for (const part of graphemes(word)) {
      const size = terminalCellWidth(part);
      if (line && used + size > width) { lines.push(line); line = ""; used = 0; }
      line += part; used += size;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/** Input has already passed sanitizeTerminalText; only generated styles are emitted. */
export function renderTerminalTable(lines: readonly string[], columns: number, color: boolean): string {
  const rows = [lines[0]!, ...lines.slice(2)].map(line => tableCells(line).map(plainCell));
  const count = rows[0]!.length;
  const width = Math.max(4, Math.min(240, Number.isFinite(columns) ? Math.floor(columns) - 1 : 79));
  const bold = (value: string) => color ? `\x1b[1m${value}\x1b[0m` : value;
  if (width < count * 7 + 1) {
    // Stacked cells stay readable when a grid would leave no room for values.
    if (rows.length === 1) return rows[0]!.map(cell => bold(wrap(cell, width).join("\n"))).join("\n") + "\n";
    return rows.slice(1).map(row => row.map((cell, i) =>
      [bold(wrap(rows[0]![i]! + ":", width).join("\n")), ...wrap(cell, width)].join("\n")
    ).join("\n")).join("\n\n") + "\n";
  }
  const desired = Array.from({ length: count }, (_, i) => Math.max(4, ...rows.map(row => terminalCellWidth(row[i] ?? ""))));
  const widths = Array<number>(count).fill(4);
  let remaining = width - 7 * count - 1;
  while (remaining-- > 0) {
    let smallest = -1;
    for (let i = 0; i < count; i++) if (widths[i]! < desired[i]! &&
      (smallest < 0 || widths[i]! < widths[smallest]!)) smallest = i;
    if (smallest < 0) break;
    widths[smallest]!++;
  }
  const align = tableCells(lines[1]!).map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left");
  const border = (left: string, mid: string, right: string) => left + widths.map(size => "─".repeat(size + 2)).join(mid) + right;
  const rendered = [border("┌", "┬", "┐")];
  rows.forEach((row, index) => {
    const cells = widths.map((size, i) => wrap(row[i] ?? "", size));
    for (let line = 0; line < Math.max(...cells.map(cell => cell.length)); line++) {
      rendered.push("│ " + cells.map((cell, i) => {
        const text = cell[line] ?? "", spare = widths[i]! - terminalCellWidth(text);
        const left = align[i] === "right" ? spare : align[i] === "center" ? Math.floor(spare / 2) : 0;
        const padded = " ".repeat(left) + text + " ".repeat(spare - left);
        return index === 0 ? bold(padded) : padded;
      }).join(" │ ") + " │");
    }
    if (index === 0) rendered.push(border("├", "┼", "┤"));
  });
  rendered.push(border("└", "┴", "┘"));
  return rendered.join("\n") + "\n";
}
