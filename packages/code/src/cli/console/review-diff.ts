import { revealInvisible } from "../../../../../src/review/reveal-invisible.js";
import { sanitizeTerminalText } from "../terminal/terminal-ui.js";
import { terminalCellWidth } from "../terminal/terminal-table.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RenderedReviewDiff {
  lines: string[];
  /** Body line indexes of each hunk header, for n/p. */
  hunks: number[];
}

interface Token { text: string; start: number; end: number }

const tokensOf = (value: string): Token[] => {
  const tokens: Token[] = [];
  const pattern = /\s+|\S+/g;
  for (const match of value.matchAll(pattern)) {
    const text = match[0];
    tokens.push({ text, start: match.index ?? 0, end: (match.index ?? 0) + text.length });
  }
  return tokens;
};

/** Mark tokens that differ between a removed line and its added pair. */
export const markWordChanges = (before: string, after: string) => {
  const oldTokens = tokensOf(before);
  const newTokens = tokensOf(after);
  const rows = oldTokens.length + 1;
  const cols = newTokens.length + 1;
  const scores = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let row = oldTokens.length - 1; row >= 0; row -= 1) {
    for (let col = newTokens.length - 1; col >= 0; col -= 1) {
      const current = scores[row];
      const next = scores[row + 1];
      if (!current || !next) continue;
      current[col] = oldTokens[row]?.text === newTokens[col]?.text
        ? (next[col + 1] ?? 0) + 1
        : Math.max(next[col] ?? 0, current[col + 1] ?? 0);
    }
  }
  const oldChanged = new Set<number>();
  const newChanged = new Set<number>();
  let row = 0;
  let col = 0;
  while (row < oldTokens.length && col < newTokens.length) {
    if (oldTokens[row]?.text === newTokens[col]?.text) { row += 1; col += 1; continue; }
    const down = scores[row + 1]?.[col] ?? 0;
    const right = scores[row]?.[col + 1] ?? 0;
    if (down >= right) { oldChanged.add(row); row += 1; }
    else { newChanged.add(col); col += 1; }
  }
  while (row < oldTokens.length) { oldChanged.add(row); row += 1; }
  while (col < newTokens.length) { newChanged.add(col); col += 1; }
  return { before: wrapChanged(before, oldTokens, oldChanged), after: wrapChanged(after, newTokens, newChanged) };
};

const wrapChanged = (value: string, tokens: readonly Token[], changed: ReadonlySet<number>) => {
  let cursor = 0;
  let text = "";
  tokens.forEach((token, index) => {
    text += value.slice(cursor, token.start);
    const meaningful = changed.has(index) && token.text.trim().length > 0;
    text += meaningful ? `«${token.text}»` : token.text;
    cursor = token.end;
  });
  return text + value.slice(cursor);
};

const wrapCode = (gutter: string, code: string, width: number) => {
  const indent = /^(\s*)/.exec(code)?.[1] ?? "";
  const budget = Math.max(1, width - terminalCellWidth(gutter));
  if (terminalCellWidth(code) <= budget) return [gutter + code];
  const parts: string[] = [];
  let line = "";
  let cells = 0;
  let first = true;
  let open = false;
  for (const { segment } of segments.segment(code)) {
    const size = terminalCellWidth(segment);
    const limit = first ? budget : Math.max(1, budget - terminalCellWidth(indent));
    const closer = open && segment === "»";
    if (line && cells + size > limit && !closer) {
      if (line.endsWith("«")) {
        const kept = line.slice(0, -1);
        if (kept) parts.push(kept);
        line = "«";
        cells = terminalCellWidth("«");
      } else {
        if (open) line += "»";
        parts.push(line);
        line = open ? "«" : "";
        cells = line ? terminalCellWidth(line) : 0;
      }
      first = false;
    }
    if (segment === "«") open = true;
    else if (segment === "»") open = false;
    line += segment;
    cells += size;
  }
  if (line) parts.push(line);
  const pad = " ".repeat(terminalCellWidth(gutter));
  return parts.map((part, index) => index === 0 ? gutter + part : pad + indent + part);
};

const gutterFor = (oldNo: number | null, newNo: number | null, mark: string) =>
  `${oldNo === null ? "      " : String(oldNo).padStart(6, " ")} ${newNo === null ? "      " : String(newNo).padStart(6, " ")} ${mark}`;

/**
 * Line numbers, word markers, indent-preserving soft wrap, and collapsed-context banners.
 * The body is already terminal-safe. Callers must not hard-wrap it again.
 */
export const renderReviewedDiff = (diff: string, width: number): RenderedReviewDiff => {
  const source = diff.split("\n").map(line => revealInvisible(line));
  const lines: string[] = [];
  const hunks: number[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const removed: string[] = [];
  const added: string[] = [];
  const emitChange = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let index = 0; index < pairs; index += 1) {
      const marked = markWordChanges(removed[index] ?? "", added[index] ?? "");
      lines.push(...wrapCode(gutterFor(oldNo, null, "-"), marked.before, width));
      oldNo += 1;
      lines.push(...wrapCode(gutterFor(null, newNo, "+"), marked.after, width));
      newNo += 1;
    }
    for (const text of removed.slice(pairs)) {
      lines.push(...wrapCode(gutterFor(oldNo, null, "-"), text, width));
      oldNo += 1;
    }
    for (const text of added.slice(pairs)) {
      lines.push(...wrapCode(gutterFor(null, newNo, "+"), text, width));
      newNo += 1;
    }
    removed.length = 0;
    added.length = 0;
  };
  for (const raw of source) {
    if (!raw) continue;
    const boundary = raw.startsWith("··· ") || raw.startsWith("--- ") || raw.startsWith("+++ ")
      || raw.startsWith("Reviewed file diff") || raw.startsWith("File diff") || raw.startsWith("\\ No newline");
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(raw);
    if (boundary || hunk || !raw.startsWith("-") && !raw.startsWith("+") && inHunk && raw.startsWith(" ")) emitChange();
    if (boundary) { lines.push(raw); continue; }
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      hunks.push(lines.length);
      lines.push(raw);
      continue;
    }
    if (!inHunk) { lines.push(raw); continue; }
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "-") {
      if (added.length) emitChange();
      removed.push(text);
    } else if (mark === "+") added.push(text);
    else if (mark === " ") {
      lines.push(...wrapCode(gutterFor(oldNo, newNo, " "), text, width));
      oldNo += 1;
      newNo += 1;
    } else lines.push(raw);
  }
  emitChange();
  return { lines, hunks };
};

const statedIntent = (argumentsText: string) => {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    for (const key of ["intent", "reason", "summary", "description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return sanitizeTerminalText(value.trim().split("\n").slice(0, 2).join(" ")).slice(0, 220);
    }
  } catch { return undefined; }
};

/** One or two lines: the agent's stated intent when present, otherwise what the diff itself changes. */
export const changeSummary = (approval: { name: string; arguments: string }, diffBody: string) => {
  const intent = statedIntent(approval.arguments);
  const added = diffBody.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
  let file = "";
  try {
    const parsed: unknown = JSON.parse(approval.arguments);
    const record = parsed as { path?: unknown; changes?: { path?: unknown }[] };
    if (typeof record?.path === "string") file = record.path;
    else if (typeof record?.changes?.[0]?.path === "string") file = record.changes[0].path;
  } catch { /* The diff header still names the file. */ }
  if (!file) file = /^\+\+\+ (.+)$/m.exec(diffBody)?.[1]?.replace(/^"|"$/g, "") ?? "";
  const safeFile = file ? sanitizeTerminalText(file) : "";
  if (intent) return safeFile ? `${intent} (${safeFile})` : intent;
  const thrown = /throw new ([A-Za-z0-9_]+)(?:\((["'])([^"']*)\2\))?/.exec(added);
  if (thrown && safeFile) return `Update ${safeFile}. ${thrown[3] ? thrown[3] : `Throw ${thrown[1]}`}.`;
  if (approval.name === "run_check" || approval.name.startsWith("run_environment_")) {
    return "Run the command shown below. It does not run until you approve.";
  }
  if (safeFile) return `Update ${safeFile}. Review the highlighted edits. Nothing is written until you approve.`;
  return "Review this change. Nothing is written until you approve.";
};
