import { afterEach, expect, test } from "bun:test";
import { paintTerminal, resolveTerminalTheme, terminalThemeChoice, terminalThemeCommand, terminalToneCode } from "../src/cli/terminal/terminal-theme.js";
import { formatConsoleDiff } from "../src/cli/console/console-context.js";
import { terminalSupportsColor } from "../src/cli/terminal/terminal-ui.js";
import { searchConsoleCommands } from "../src/cli/console/console-commands.js";
afterEach(() => { terminalThemeCommand('/theme system'); });
test('system detects a light terminal and unknown backgrounds default to dark', () => {
  expect(resolveTerminalTheme('system', { COLORFGBG: '0;15' })).toBe('light');
  expect(resolveTerminalTheme('system', { COLORFGBG: '15;0' })).toBe('dark');
  expect(resolveTerminalTheme('system', {})).toBe('dark');
  expect(resolveTerminalTheme('dark', { COLORFGBG: '0;15' })).toBe('dark');
  expect(resolveTerminalTheme('system', { COLORFGBG: 'invalid;999' })).toBe('dark');
});
test('switching themes changes diff contrast without dropping content or changing background', () => {
  terminalThemeCommand('/theme light');
  const light = formatConsoleDiff('+new\n-old\n@@ location', true);
  expect(light).toContain('\x1b[38;5;22m+new');
  expect(terminalToneCode('muted')).toBe('38;5;59');
  terminalThemeCommand('/theme dark');
  const dark = formatConsoleDiff('+new\n-old\n@@ location', true);
  expect(dark).toContain('\x1b[38;5;120m+new');
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]+m/g, '');
  expect(plain(light)).toBe(plain(dark));
  expect(light + dark).not.toContain('\x1b[48;');
});
test('invalid theme does not change choice and both console modes discover the command', () => {
  terminalThemeCommand('/theme light');
  expect(terminalThemeCommand('/theme bogus')).toContain('Usage:');
  expect(terminalThemeChoice()).toBe('light');
  for (const mode of ['direct', 'service'] as const) expect(searchConsoleCommands('theme', mode)[0]?.[0]).toBe('/theme');
});
test('no-color diffs stay plain and control bytes stay inert in both themes', () => {
  for (const theme of ['light', 'dark']) {
    terminalThemeCommand(`/theme ${theme}`);
    expect(paintTerminal('plain', 'muted', false)).toBe('plain');
    expect(formatConsoleDiff('+\x1b[2J', false)).toBe('+\\u001b[2J');
  }
  expect(terminalSupportsColor(true, { NO_COLOR: '1' })).toBe(false);
});
