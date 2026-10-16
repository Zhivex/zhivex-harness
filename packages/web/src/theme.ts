export const THEME_KEY = "zhivex.code.theme.v1";
export type ThemeChoice = "light" | "dark" | "system";

export function readThemeChoice(storage: Pick<Storage, "getItem"> | undefined): ThemeChoice {
  const value = storage?.getItem(THEME_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark ? "dark" : "light";
}

export function applyTheme(choice: ThemeChoice, prefersDark: boolean) {
  const resolved = resolveTheme(choice, prefersDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = choice;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}
