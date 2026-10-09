import { consoleLabel, consoleLines, consoleStateLines, consoleWidth, type ConsoleComposerInput } from "./console-presentation.js";
import { terminalCellWidth } from "../terminal/terminal-table.js";

export interface ConsoleReview {
  title: string;
  body: string;
  state?: ConsoleComposerInput;
  notice?: string;
}

const fits = (text: string, width: number) => terminalCellWidth(text) <= width;

/** Name the highlighted decision. Enter never confirms a different row. */
const confirmHint = (label: string, width: number) => {
  const named = `Enter confirms ${label}`;
  const withEscape = `${named} · Esc pending`;
  const full = `↑↓ choose · ${withEscape}`;
  if (fits(full, width)) return full;
  if (fits(withEscape, width)) return withEscape;
  return consoleLabel(named, width);
};

/** Fixed decisions; pageable, character-preserving diff/payload above them. */
export const reviewFrame = (review: ConsoleReview, items: readonly { label: string; index: number; detail?: string }[],
  selected: number, query: string, offset: number, columns = 80, rows = 24, wrappedBody?: readonly string[]) => {
  const width = consoleWidth(columns);
  const state = ["( Z ) Zhivex Code · review", ...(review.state ? consoleStateLines(review.state, columns) : [])];
  const body = wrappedBody ?? consoleLines(review.body, width);
  const highlighted = items[selected]?.label ?? "highlighted decision";
  const footer = [consoleLabel(review.title, width),
    ...items.map((item, index) => {
      const base = `${index === selected ? ">" : " "} ${item.label}`;
      const detailed = item.detail ? `${base} · ${item.detail}` : base;
      return consoleLabel(fits(detailed, width) ? detailed : base, width);
    }),
    ...(!items.length ? ["  No matches; edit filter"] : []),
    consoleLabel(`Filter > ${query}`, width),
    confirmHint(highlighted, width),
    consoleLabel(review.notice ?? "PgUp/PgDn review · details via menu", width)];
  // A resize may reduce height mid-review; decisions take priority over metadata.
  const header = state.slice(0, Math.max(1, rows - footer.length - 4));
  const capacity = Math.max(1, rows - header.length - footer.length - 3);
  const start = Math.max(0, Math.min(offset, Math.max(0, body.length - capacity)));
  const visible = body.slice(start, start + capacity);
  const lines = [...header, "─".repeat(width), ...visible,
    ...Array<string>(Math.max(0, capacity - visible.length)).fill(""),
    consoleLabel(`Review lines ${start + 1}–${Math.min(start + capacity, body.length)}/${body.length}${body.length > capacity ? " · more below/above" : " · complete"}`, width),
    "─".repeat(width), ...footer];
  return { lines, offset: start, capacity, filterRow: lines.length - 2 };
};
