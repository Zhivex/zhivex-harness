import { consoleLabel } from "./console-presentation.js";
import { sanitizeTerminalText, terminalSupportsColor } from "../terminal/terminal-ui.js";

// Sampled from desktop/assets/zhivex-logo.png: the original Zhivex Z and connected nodes.
// The sampled grid is 12×24. Code trims the blank padding rows and draws the remaining 10.
const LOGO_PADDING = "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀";
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

const LEGACY_TERMINAL_LOGO = [LOGO_PADDING, ZHIVEX_TERMINAL_LOGO, LOGO_PADDING].join("\n");

export interface ConsoleWelcomeInput {
  version: string;
  workspace: string;
  sessionId?: string;
  sessionTitle?: string;
  provider?: string;
  model?: string;
  service?: boolean;
}

export interface ConsoleWelcomeOptions {
  color?: boolean;
  columns?: number;
  rows?: number;
  compact?: boolean;
  tty?: boolean;
  term?: string;
  /** Direct `zhivex-code` chat. Omitted calls, including the service client, keep the previous welcome. */
  layout?: "code";
  policy?: string;
  restored?: boolean;
}

const projectLabel = (workspace: string) => {
  const home = process.env.HOME;
  const relative = home && (workspace === home || workspace.startsWith(`${home}/`))
    ? `~${workspace.slice(home.length)}` : workspace;
  return sanitizeTerminalText(relative);
};

/** Previous welcome, including the padded 12-row mark. The service client depends on this output. */
const formatLegacyWelcome = (input: ConsoleWelcomeInput, options: ConsoleWelcomeOptions) => {
  const safe = sanitizeTerminalText;
  const color = options.color ?? terminalSupportsColor(Boolean(process.stdout.isTTY));
  const columns = options.columns ?? 80;
  const title = `Zhivex Code ${safe(input.version)}`;
  const logo = columns < 48 || options.compact ? "( Z )" : LEGACY_TERMINAL_LOGO;
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
  return [
    header,
    ...(titleBesideLogo ? (logoLines.length === 1 ? context : []) : [title, ...context]),
  ].join("\n");
};

/** First welcome of a new Code session. A restored session never prints the braille mark. */
const formatCodeWelcome = (input: ConsoleWelcomeInput, options: ConsoleWelcomeOptions) => {
  const safe = sanitizeTerminalText;
  const color = options.color ?? terminalSupportsColor(Boolean(process.stderr.isTTY));
  const columns = options.columns ?? (process.stderr.columns || process.stdout.columns || 80);
  const rows = options.rows ?? (process.stderr.rows || process.stdout.rows || 24);
  const tty = options.tty ?? Boolean(process.stderr.isTTY);
  const term = options.term ?? process.env.TERM;
  const version = safe(input.version);
  const title = `Zhivex Code ${version}`;
  const project = `${projectLabel(input.workspace)} · ${safe(input.provider ?? "not configured")}/${safe(input.model ?? "not selected")}`;
  if (options.restored) return `( Z ) ${title} · ${project}`;
  const welcome = "Welcome. What would you like to work on?";
  const policy = options.policy ?? "Zhivex asks before it changes files.";
  const showLogo = !options.compact && tty && term !== "dumb" && columns >= 48 && rows >= 24;
  if (!showLogo) return [`( Z ) ${title}`, project, welcome, policy].join("\n");
  const logoLines = ZHIVEX_TERMINAL_LOGO.split("\n");
  const logoWidth = Math.max(...logoLines.map(line => line.length));
  const side = [title, project, "", welcome, policy];
  const room = Math.max(1, columns - logoWidth - 3);
  const paint = (label: string, index: number) => {
    const bounded = consoleLabel(label, room);
    if (!color || !bounded) return bounded;
    if (index === 0) return `\u001b[1mZhivex Code \u001b[0m\u001b[90m${version}\u001b[0m`;
    if (index === 1) return `\u001b[90m${bounded}\u001b[0m`;
    return bounded;
  };
  if (columns < logoWidth + 3 + title.length) {
    const stacked = side.map(label => label ? consoleLabel(label, Math.max(1, columns)) : "");
    return [logoLines.map(line => color ? `\u001b[31m${line}\u001b[0m` : line).join("\n"), ...stacked].join("\n");
  }
  const titleRow = Math.max(0, Math.floor((logoLines.length - side.length) / 2));
  return logoLines.map((line, index) => {
    const mark = color ? `\u001b[31m${line}\u001b[0m` : line;
    const label = side[index - titleRow];
    return label ? `${mark}${" ".repeat(logoWidth - line.length + 3)}${paint(label, index - titleRow)}` : mark;
  }).join("\n");
};

export const formatConsoleWelcome = (input: ConsoleWelcomeInput, options: ConsoleWelcomeOptions = {}) =>
  options.layout === "code" ? formatCodeWelcome(input, options) : formatLegacyWelcome(input, options);
