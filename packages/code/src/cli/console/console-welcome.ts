import { consoleLabel } from "./console-presentation.js";
import { sanitizeTerminalText, terminalSupportsColor } from "../terminal/terminal-ui.js";

// Sampled from desktop/assets/zhivex-logo.png: the original Zhivex Z and connected nodes.
// The sampled grid is 12×24; the first and last rows are blank padding, so the mark is 10 rows.
export const ZHIVEX_TERMINAL_LOGO = [
  "⠀⠀⠀⠀⠀⠀⠀⣀⣤⣴⡶⠶⠶⠶⣦⣤⣀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⣠⡾⠋⠉⠀⠀⠀⠀⠀⠀⠈⠙⢷⣄⠀⠀⠀⠀⠀",
  "⠀⠀⠀⢀⡾⠋⠀⠴⠿⠿⠿⠿⠿⠿⣿⣿⡿⠋⠙⣷⡀⠀⠀⠀",
  "⠀⠀⠀⣾⠃⠀⠀⠀⠀⠀⠀⠀⣠⣾⡿⠋⠀⠀⠀⣸⣷⠀⠀⠀",
  "⠀⠀⢸⡟⠀⠀⠀⠀⠀⠀⣠⣾⡿⠋⠀⠀⢰⣶⡞⠁⣿⡆⠀⠀",
  "⠀⠀⠸⣷⠀⠀⠀⢀⣠⣾⡿⠋⠀⠀⢀⣴⠞⠙⠁⠀⣿⠇⠀⠀",
  "⠀⠀⠀⢿⣆⢀⣤⣾⣿⣿⣶⣶⣶⣶⣿⡁⠀⠀⠀⣰⡟⠀⠀⠀",
  "⠀⠀⠀⠈⠻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠈⣿⣿⢀⣴⠟⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠈⠻⢶⣤⣀⡀⠀⠀⢀⣀⣤⡶⠟⠁⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⠛⠛⠛⠛⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀",
].join("\n");

export const formatConsoleWelcome = (input: {
  version: string;
  workspace: string;
  sessionId?: string;
  sessionTitle?: string;
  provider?: string;
  model?: string;
  service?: boolean;
}, options: { color?: boolean; columns?: number; rows?: number; compact?: boolean; tty?: boolean; term?: string } = {}) => {
  const safe = sanitizeTerminalText;
  const color = options.color ?? terminalSupportsColor(Boolean(process.stdout.isTTY));
  const columns = options.columns ?? 80;
  const rows = options.rows ?? process.stderr.rows ?? 0;
  const tty = options.tty ?? Boolean(process.stderr.isTTY);
  const term = options.term ?? process.env.TERM;
  const title = `Zhivex Code ${safe(input.version)}`;
  // Full mark only on a real stderr terminal that can hold it. Color is a separate switch.
  const logo = !options.compact && tty && term !== "dumb" && columns >= 48 && rows >= 24
    ? ZHIVEX_TERMINAL_LOGO : "( Z )";
  const logoLines = logo.split("\n");
  const logoWidth = Math.max(...logoLines.map(line => line.length));
  const titleBesideLogo = columns >= logoWidth + 3 + title.length;
  const context = [
    "Welcome. What would you like to work on?",
    `Project: ${safe(input.workspace)}`,
    input.service ? "Runtime: local service · managed by host" :
      `Model: ${safe(input.provider ?? "not configured")}/${safe(input.model ?? "not selected")}`,
    input.sessionId ? `session ${safe(input.sessionTitle ?? input.sessionId)}` : "",
  ].filter(Boolean);
  const right = [title, ...context];
  const titleRow = Math.max(0, Math.floor((logoLines.length - right.length) / 2));
  const header = logoLines.map((line, index) => {
    const mark = color ? `\u001b[31m${line}\u001b[0m` : line;
    const label = titleBesideLogo ? right[index - titleRow] : undefined;
    return label
      ? `${mark}${" ".repeat(logoWidth - line.length + 3)}${color ? (index === titleRow ? "\u001b[1m" : "\u001b[90m") : ""}${consoleLabel(label, columns - logoWidth - 3)}${color ? "\u001b[0m" : ""}`
      : mark;
  }).join("\n");
  // Compact-logo layouts have only one row; retain their context below it.
  return [
    header,
    ...(titleBesideLogo ? (logoLines.length === 1 ? context : []) : [title, ...context]),
  ].join("\n");
};
