import { sanitizeTerminalText, terminalSupportsColor } from "../terminal/terminal-ui.js";
import { terminalCellWidth } from "../terminal/terminal-table.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Hard-wrap without dropping spaces or code characters. Only trusted styles follow. */
export const consoleLines = (text: string, width: number): string[] => {
  const result: string[] = [];
  for (const source of sanitizeTerminalText(text).replace(/\t/g, "    ").split("\n")) {
    let line = "", cells = 0;
    for (const { segment } of segments.segment(source)) {
      const size = terminalCellWidth(segment);
      if (line && cells + size > Math.max(1, width)) { result.push(line); line = ""; cells = 0; }
      line += segment; cells += size;
    }
    result.push(line);
  }
  return result;
};

/** Bound presentation metadata without allowing paths/titles to control the terminal. */
export const consoleLabel = (text: string, width: number) => {
  if (width <= 0) return "";
  const safe = sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
  if (terminalCellWidth(safe) <= width) return safe;
  let value = "";
  for (const { segment } of segments.segment(safe)) {
    if (terminalCellWidth(value + segment) > width - 1) break;
    value += segment;
  }
  return value + "…";
};

export interface ConsoleComposerInput {
  model: string;
  reasoning?: string;
  title?: string;
  status: string;
  attachments?: number;
  automaticApprovals?: boolean;
  approvalMode?: "ask" | "auto" | "restricted";
  runUsage?: { estimatedUsd: number | null; limitUsd: number | null; usageComplete: boolean };
  nextLimitUsd?: number | null;
  contextTokens?: number;
}

export const consoleWidth = (columns = 80) => Math.max(1, Math.min((columns || 80) - 1, 100));
const muted = (text: string, color: boolean) => color ? `\u001b[38;5;250m${text}\u001b[0m` : text;
const usd = (value: number | null | undefined) => typeof value === "number" ? `$${value.toFixed(6)}` : "unknown";
const money = (value: number) => `$${value.toFixed(6)}`;
const pendingDecision = (status: string) => status.startsWith("Waiting for your decision") || status.startsWith("approval pending");

/** Ask / auto / restricted stay the same three modes. The ask phrase matches the idle composer. */
const approvalPhrase = (input: ConsoleComposerInput) => input.approvalMode === "restricted" ? "restricted approvals"
  : input.approvalMode === "auto" || input.automaticApprovals ? "auto approvals" : "ask before changes";

/** One composer/dock line. Cost appears only for a real cap or an incomplete capped run. */
export const consoleStatusParts = (input: ConsoleComposerInput) => {
  const runCap = input.runUsage?.limitUsd;
  const nextCap = input.nextLimitUsd;
  const hasRunCap = typeof runCap === "number";
  const hasNextCap = typeof nextCap === "number";
  const incomplete = Boolean(input.runUsage && !input.runUsage.usageComplete && (hasRunCap || hasNextCap));
  const showRun = Boolean(input.runUsage && (hasRunCap || incomplete || (hasNextCap && typeof input.runUsage.estimatedUsd === "number")));
  const attachments = (input.attachments ?? 0) > 0 ? `${input.attachments} attached` : "";
  return [
    `${input.model} · ${approvalPhrase(input)} · ${input.status}`,
    ...(attachments ? [attachments] : []),
    ...(showRun && input.runUsage ? [`Run est. ${usd(input.runUsage.estimatedUsd)}${input.runUsage.usageComplete ? "" : " INCOMPLETE"}${hasRunCap ? ` / ${money(runCap)} cap` : ""}`] : []),
    ...(hasNextCap ? [`Next run cap ${money(nextCap)}`] : []),
  ];
};

export const consoleStatusText = (input: ConsoleComposerInput) => consoleStatusParts(input).join(" · ");

/** Keep each clause whole so `Run est. unknown INCOMPLETE` stays on one row. */
const packClauses = (parts: readonly string[], width: number) => {
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const next = current ? `${current} · ${part}` : part;
    if (current && terminalCellWidth(next) > width) {
      lines.push(current);
      current = part;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.flatMap(line => terminalCellWidth(line) > width ? consoleLines(line, width) : [line]);
};

export const consoleStateLines = (input: ConsoleComposerInput, columns = 80) =>
  packClauses(consoleStatusParts(input), consoleWidth(columns));

/** The service client keeps the previous four-line composer. Direct chat uses one status line. */
const legacyStateLines = (input: ConsoleComposerInput, columns = 80) => {
  const width = consoleWidth(columns);
  const policy = input.approvalMode === "restricted" ? "restricted approvals"
    : input.approvalMode === "auto" || input.automaticApprovals ? "auto approvals" : "review approvals";
  const cap = (value: number | null | undefined) => typeof value === "number" ? money(value) : "none";
  return [
    ...consoleLines(consoleLabel(`Model ${input.model}${input.reasoning ? ` · ${input.reasoning}` : ""}`, width * 2), width),
    ...(input.runUsage ? consoleLines(`Run est. ${usd(input.runUsage.estimatedUsd)}${input.runUsage.usageComplete ? "" : " INCOMPLETE"} / ${cap(input.runUsage.limitUsd)} cap`, width) : ["Run: no usage recorded"]),
    ...consoleLines(`Next run cap ${cap(input.nextLimitUsd)} · ${policy}`, width),
    ...consoleLines(`Context ~${input.contextTokens ?? 0} retained tokens* · ${input.attachments ?? 0} attached`, width),
  ];
};

/** Focus keeps policy and pending decisions ahead of optional presentation metadata. */
export const formatComposer = (input: ConsoleComposerInput, columns = 80,
  color = terminalSupportsColor(Boolean(process.stdout.isTTY)), layout: "legacy" | "focus" = "legacy") => {
  const width = consoleWidth(columns);
  const title = input.title ? muted(consoleLabel(input.title, width), color) + "\n" : "";
  if (layout === "focus") return `\n${title}${muted("─".repeat(width), color)}\n`;
  const status = consoleLabel(input.status, width);
  const painted = color && pendingDecision(input.status) ? `\u001b[33m${status}\u001b[0m` : status;
  return `\n${title}${legacyStateLines(input, columns).map(line => muted(line, color)).join("\n")}\n${painted}\n${muted("─".repeat(width), color)}\n`;
};

export const formatComposerFooter = (columns = 80, color = false, focus?: ConsoleComposerInput) => {
  const width = consoleWidth(columns);
  const rule = muted("─".repeat(width), color);
  if (!focus) {
    const hints = width >= 65 ? "/ commands · Ctrl+R history · Alt+Enter newline · ? shortcuts"
      : width >= 40 ? "/ commands · Ctrl+R history · ? shortcuts" : "/ commands · ? help";
    return [rule, muted(consoleLabel(hints, width), color)];
  }
  const hints = width >= 32 ? "/ commands · ? shortcuts" : "?";
  const text = consoleStatusText(focus);
  const paint = (line: string) => color && pendingDecision(focus.status) ? `\u001b[33m${line}\u001b[0m` : muted(line, color);
  const hintWidth = terminalCellWidth(hints);
  if (terminalCellWidth(text) + 2 + hintWidth <= width) {
    return [rule, `${paint(text)}${" ".repeat(width - terminalCellWidth(text) - hintWidth)}${muted(hints, color)}`];
  }
  return [rule, ...consoleStateLines(focus, columns).map(paint), muted(consoleLabel(hints, width), color)];
};

export const formatComposerPlaceholder = (columns = 80, color = false) =>
  muted(consoleLabel("Ask a question or describe a task", Math.max(0, consoleWidth(columns) - 2)), color);

export const CONSOLE_SHORTCUTS = [
  "Keyboard shortcuts",
  "Enter       Send task (history search only restores a draft)",
  "Alt+Enter   Insert a newline",
  "Up / Down   Move within multiline input; recall history at its edges",
  "Ctrl+R      Search this session's in-memory prompt history",
  "Tab         Insert selected command or history match",
  "Esc         Close command menu or cancel history search",
  "Ctrl+C      Discard draft or cancel the active operation",
  "Ctrl+D      Exit when the draft is empty",
  "/menu       Browse providers, models and conversations",
  "/resume     Choose a saved conversation",
  "Credential source, retained-token estimates and run caps are on /status.",
  "Context estimates cover retained messages only. They exclude request instructions and tools. Costs are estimates, not invoices.",
  "While working: type a draft, Enter queues the next task, Up recalls the last queued task. Ctrl+C stops and clears the queue.",
].join("\n");

export const chooseConsoleItem = async <T>(
  title: string,
  items: readonly { value: T; label: string; detail?: string; key?: string }[],
  io: { write(text: string): void; ask(prompt: string): Promise<string> },
): Promise<T | undefined> => {
  if (!items.length) { io.write("No matches.\n"); return undefined; }
  let query = "";
  for (;;) {
    const matches = items.filter(item => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    const visible = matches.slice(0, 12);
    io.write(`\n${sanitizeTerminalText(title)}\n` + visible.map((item, i) =>
      `  ${i + 1}. ${consoleLabel(item.label, 60)}${item.detail ? ` · ${consoleLabel(item.detail, 60)}` : ""}`).join("\n") +
      `\n${matches.length > 12 ? `${matches.length} matches; type a filter to narrow the list.\n` : ""}`);
    const answer = (await io.ask("Choose number, type a filter, or Enter to cancel: ")).trim();
    if (!answer) return undefined;
    if (/^[a-z]$/.test(answer)) {
      const keyed = items.find(item => item.key === answer);
      if (keyed) return keyed.value;
    }
    if (/^\d+$/.test(answer)) {
      const selected = visible[Number(answer) - 1];
      if (selected) return selected.value;
      io.write("Choose a number from the visible list.\n");
    } else query = answer;
  }
};
