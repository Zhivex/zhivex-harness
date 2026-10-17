import { consoleLabel, consoleLines, consoleWidth } from "./console-presentation.js";
import { terminalCellWidth } from "../terminal/terminal-table.js";

export interface ConsoleReview {
  title: string;
  body: string;
  /** One or two lines of intent, kept above the scrolling diff. */
  summary?: string;
  /** Per-file `path  +added −removed` lines, kept above the scrolling diff. */
  fileList?: string;
  /** Preformatted diff. Line indexes are hunk headers for n/p. */
  layout?: (width: number) => { lines: readonly string[]; hunks: readonly number[] };
  /** `~/project · provider/model` on the right of the one-line header. */
  headerRight?: string;
  /** Files represented in the diff, for the end-of-changes line. */
  files?: number;
  notice?: string;
}

export interface ReviewItem {
  label: string;
  index: number;
  detail?: string;
  /** Single letter, or `Esc`, drawn beside the label. */
  key?: string;
}

const fits = (text: string, width: number) => terminalCellWidth(text) <= width;

const hintFor = (width: number, selected: number) => {
  const options = selected < 0 ? [
    "No action highlighted · ↑↓ then a or r · n/p hunks · PgUp/PgDn",
    "No action highlighted · a or r · PgUp/PgDn",
    "a approve · r reject · PgUp/PgDn",
    "PgUp/PgDn",
  ] : [
    "↑↓ move · Enter confirms the highlight · n/p hunks · PgUp/PgDn",
    "Enter confirms the highlight · PgUp/PgDn",
    "n/p hunks · PgUp/PgDn",
    "PgUp/PgDn",
  ];
  return options.find(option => fits(option, width)) ?? "PgUp/PgDn";
};

const headerLine = (right: string, width: number) => {
  const left = "( Z ) Review changes";
  const place = (value: string) => {
    const gap = width - terminalCellWidth(left) - terminalCellWidth(value);
    return gap >= 2 ? left + " ".repeat(gap) + value : undefined;
  };
  if (right) {
    const full = place(right);
    if (full) return full;
    const project = right.split(" · ")[0] ?? "";
    const short = project && project !== right ? place(project) : undefined;
    if (short) return short;
  }
  return consoleLabel(left, width);
};

/** Wrap on spaces so a decision label is never cut mid-word or ellipsized. */
const wrapWords = (text: string, width: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next, width)) { line = next; continue; }
    if (line) lines.push(line);
    if (fits(word, width)) line = word;
    else {
      const broken = consoleLines(word, width);
      lines.push(...broken.slice(0, -1));
      line = broken.at(-1) ?? "";
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
};

const itemLines = (items: readonly ReviewItem[], selected: number, width: number, details: boolean) => {
  const lines: string[] = [];
  for (const [index, item] of items.entries()) {
    const mark = index === selected ? "> " : "  ";
    const key = item.key ? `${item.key}  ` : "";
    lines.push(...wrapWords(`${mark}${key}${item.label}`, width));
    if (details && item.detail) lines.push(...wrapWords(`    ${item.detail}`, width));
  }
  return lines;
};

/** Pageable diff above a fixed decision menu. No filter row. */
export const reviewFrame = (review: ConsoleReview, items: readonly ReviewItem[],
  selected: number, _query: string, offset: number, columns = 80, rows = 24, wrappedBody?: readonly string[]) => {
  const width = consoleWidth(columns);
  const summary = review.summary ? wrapWords(review.summary, width).slice(0, 2) : [];
  const files = review.fileList ? review.fileList.split("\n").filter(Boolean).flatMap(line => wrapWords(line, width)) : [];
  const preface = [...summary, ...files];
  const body = wrappedBody ?? consoleLines(review.body, width);
  const hint = hintFor(width, selected);
  const title = consoleLabel(review.title, width);
  const notice = review.notice ? consoleLabel(review.notice, width) : undefined;
  let details = true;
  let showNotice = Boolean(notice);
  const footerOf = () => {
    const decisions = itemLines(items, selected, width, details);
    return [title, ...(decisions.length ? decisions : ["  No decisions"]), hint, ...(showNotice && notice ? [notice] : [])];
  };
  let footer = footerOf();
  while (footer.length > rows - 3 && (details || showNotice)) {
    if (details) details = false;
    else showNotice = false;
    footer = footerOf();
  }
  const chrome = preface.length + footer.length + 2;
  const capacity = Math.max(1, rows - chrome);
  const start = Math.max(0, Math.min(offset, Math.max(0, body.length - capacity)));
  const visible = body.slice(start, start + Math.min(capacity, body.length));
  const remaining = Math.max(0, body.length - (start + visible.length));
  const count = review.files ?? 0;
  const fileLabel = count === 1 ? "1 file" : `${count} files`;
  const marker = remaining > 0
    ? `↓ ${remaining} more lines · n/p hunks · PgUp/PgDn`
    : count > 0 ? `End of changes · ${fileLabel}` : "End of changes";
  const lines = [headerLine(review.headerRight ?? "", width),
    ...preface,
    ...visible,
    consoleLabel(marker, width),
    ...footer];
  const selectedRow = lines.findIndex(line => line.startsWith("> "));
  const decisionRow = lines.findIndex(line => line.includes("Reject") || line.includes("Approve"));
  return { lines, offset: start, capacity, filterRow: (selectedRow >= 0 ? selectedRow : Math.max(0, decisionRow)) + 1 };
};
