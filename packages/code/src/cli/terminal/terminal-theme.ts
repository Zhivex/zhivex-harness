/** Terminal backgrounds belong to the user's terminal; only foregrounds change. */
export type TerminalTheme = "light" | "dark" | "system";
export type TerminalTone = "muted" | "accent" | "added" | "removed" | "info" | "pending";
const palettes = {
  light: { muted: 59, accent: 160, added: 22, removed: 124, info: 25, pending: 94 },
  dark: { muted: 250, accent: 203, added: 120, removed: 210, info: 117, pending: 222 },
} as const;
let sessionTheme: TerminalTheme | undefined;
export function terminalThemeChoice(env: NodeJS.ProcessEnv = process.env): TerminalTheme {
  const choice = sessionTheme ?? env.ZHIVEX_THEME;
  return choice === "light" || choice === "dark" ? choice : "system";
}
export function resolveTerminalTheme(choice: TerminalTheme, env: NodeJS.ProcessEnv = process.env): "light" | "dark" {
  if (choice !== "system") return choice;
  const raw = env.COLORFGBG?.split(";").at(-1);
  if (raw && /^\d+$/.test(raw)) {
    const background = Number(raw);
    if (background === 7 || background === 15 || background >= 250 && background <= 255) return "light";
  }
  return "dark";
}
export function terminalToneCode(tone: TerminalTone, env: NodeJS.ProcessEnv = process.env): string {
  return `38;5;${palettes[resolveTerminalTheme(terminalThemeChoice(env), env)][tone]}`;
}
/** Input is already sanitized by the caller. Never emits control sequences without color. */
export function paintTerminal(text: string, tone: TerminalTone, color: boolean): string {
  return color ? `\u001b[${terminalToneCode(tone)}m${text}\u001b[0m` : text;
}
export function terminalThemeCommand(command: string): string {
  const value = command.slice("/theme".length).trim();
  if (value && value !== "light" && value !== "dark" && value !== "system") return "Usage: /theme light|dark|system\n";
  if (value === "light" || value === "dark" || value === "system") sessionTheme = value;
  const choice = terminalThemeChoice();
  return `Appearance: ${choice} (${resolveTerminalTheme(choice)} palette). Terminal background is unchanged.\n` +
    "Use /theme light|dark|system. Set ZHIVEX_THEME for future launches; system reads COLORFGBG, defaulting to dark.\n";
}
