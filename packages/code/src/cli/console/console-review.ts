import { consoleLabel, consoleLines, consoleStateLines, consoleWidth, type ConsoleComposerInput } from "./console-presentation.js";

export interface ConsoleReview {
  title: string;
  body: string;
  state?: ConsoleComposerInput;
  notice?: string;
}

/** Fixed decisions; pageable, character-preserving diff/payload above them. */
export const reviewFrame = (review: ConsoleReview, items: readonly { label: string; index: number }[],
  selected: number, query: string, offset: number, columns = 80, rows = 24, wrappedBody?: readonly string[]) => {
  const width = consoleWidth(columns);
  const state = ["( Z ) Zhivex Code · review", ...(review.state ? consoleStateLines(review.state, columns) : [])];
  const body = wrappedBody ?? consoleLines(review.body, width);
  const footer = [consoleLabel(review.title, width),
    ...items.map((item, index) => consoleLabel(`${index === selected ? ">" : " "} ${item.label}`, width)),
    ...(!items.length ? ["  No matches; edit filter"] : []),
    consoleLabel(`Filter > ${query}`, width),
    consoleLabel("↑↓ choose · Enter confirm · Esc pending", width),
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
