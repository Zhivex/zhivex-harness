import { consoleLabel } from "./console-presentation.js";
import { sanitizeTerminalText, terminalSupportsColor } from "../terminal/terminal-ui.js";

// Sampled from desktop/assets/zhivex-logo.png: the original Zhivex Z and connected nodes.
export const ZHIVEX_TERMINAL_LOGO = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
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
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"
].join("\n");

export const formatConsoleWelcome = (input: {
  version: string;
  workspace: string;
  sessionId?: string;
  sessionTitle?: string;
  provider?: string;
  model?: string;
  service?: boolean;
}, options: { color?: boolean; columns?: number } = {}) => {
  const safe = sanitizeTerminalText;
  const color = options.color ?? terminalSupportsColor(Boolean(process.stdout.isTTY));
  const columns = options.columns ?? 80;
  const title = `Zhivex Harness ${safe(input.version)}`;
  const logo = columns < 48 ? "( Z )" : ZHIVEX_TERMINAL_LOGO;
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
      ? `${mark}${" ".repeat(logoWidth - line.length + 3)}${consoleLabel(label, columns - logoWidth - 3)}`
      : mark;
  }).join("\n");
  // Compact-logo layouts have only one row; retain their context below it.
  return [
    header,
    ...(titleBesideLogo ? (logoLines.length === 1 ? context : []) : [title, ...context]),
    "",
    consoleLabel("Try: Explain this project · Review my changes", columns),
    consoleLabel("Type / to find commands, or ? for shortcuts.", columns),
  ].join("\n");
};
