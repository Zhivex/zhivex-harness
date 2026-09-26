import { sanitizeTerminalText, terminalSupportsColor } from "../terminal/terminal-ui.js";

/** Bound presentation metadata without allowing paths/titles to control the terminal. */
export const consoleLabel = (text: string, width: number) => {
  if (width <= 0) return "";
  const safe = sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
  const characters = Array.from(safe);
  return characters.length <= width ? safe : characters.slice(0, Math.max(0, width - 1)).join("") + "…";
};

export interface ConsoleComposerInput {
  model: string;
  reasoning?: string;
  title?: string;
  status: string;
  attachments?: number;
  automaticApprovals?: boolean;
  approvalMode?: "ask" | "auto" | "restricted";
}

export const consoleWidth = (columns = 80) => Math.max(1, Math.min((columns || 80) - 1, 100));
const muted = (text: string, color: boolean) => color ? `\u001b[90m${text}\u001b[0m` : text;

/** Focus keeps policy and pending decisions ahead of optional presentation metadata. */
export const formatComposer = (input: ConsoleComposerInput, columns = 80,
  color = terminalSupportsColor(Boolean(process.stdout.isTTY))) => {
  const width = consoleWidth(columns);
  const model = consoleLabel([input.model, input.reasoning ? `reasoning ${input.reasoning}` : undefined].filter(Boolean).join(" · "), width);
  const policy = input.approvalMode === "restricted" ? "restricted approvals"
    : input.approvalMode === "auto" || input.automaticApprovals ? "auto approvals" : "review approvals";
  const status = consoleLabel([input.status, policy, input.attachments ? `${input.attachments} attached` : undefined].filter(Boolean).join(" · "), width);
  const title = input.title ? muted(consoleLabel(input.title, width), color) + "\n" : "";
  return `\n${title}${muted(model, color)}\n${color && input.status.startsWith("approval pending") ? `\u001b[33m${status}\u001b[0m` : muted(status, color)}\n${muted("─".repeat(width), color)}\n`;
};

export const formatComposerFooter = (columns = 80, color = false) => {
  const width = consoleWidth(columns);
  const hints = width >= 65 ? "/ commands · Ctrl+R history · Alt+Enter newline · ? shortcuts"
    : width >= 40 ? "/ commands · Ctrl+R history · ? shortcuts" : "/ commands · ? help";
  return [muted("─".repeat(width), color), muted(consoleLabel(hints, width), color)];
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
].join("\n");

export const chooseConsoleItem = async <T>(
  title: string,
  items: readonly { value: T; label: string; detail?: string }[],
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
    if (/^\d+$/.test(answer)) {
      const selected = visible[Number(answer) - 1];
      if (selected) return selected.value;
      io.write("Choose a number from the visible list.\n");
    } else query = answer;
  }
};
