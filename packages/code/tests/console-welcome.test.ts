import { expect, test } from "bun:test";
import { formatComposer, formatComposerFooter } from "../src/cli/console/console-presentation.js";
import { formatConsoleWelcome, ZHIVEX_TERMINAL_LOGO } from "../src/cli/console/console-welcome.js";

const input = {
  version: "0.3.0-rc.8",
  workspace: "/tmp/project",
  sessionId: "s",
  sessionTitle: "greeting",
  provider: "openai",
  model: "gpt-5.6-luna",
};

const render = (columns: number, rows: number, extra: { tty?: boolean; term?: string; compact?: boolean; color?: boolean } = {}) =>
  formatConsoleWelcome(input, { color: false, tty: true, term: "xterm-256color", columns, rows, ...extra });

const mark = ZHIVEX_TERMINAL_LOGO.split("\n");

test("the mark is ten rows of the sampled logo", () => {
  expect(mark).toHaveLength(10);
  expect(mark.every(line => line.length === 24)).toBe(true);
  expect(mark[0]).toContain("⣀⣤⣴");
});

test("fewer than 24 rows uses the compact mark", () => {
  const rendered = render(80, 23);
  expect(rendered.startsWith("( Z )")).toBe(true);
  expect(rendered).not.toContain(mark[0]);
});

test("80x24 shows the ten-row logo", () => {
  const lines = render(80, 24).split("\n");
  expect(lines).toHaveLength(10);
  expect(lines.map(line => line.slice(0, 24))).toEqual(mark);
  expect(lines.join("\n")).not.toContain("( Z )");
  expect(lines[2]).toContain("Zhivex Code 0.3.0-rc.8");
});

test("44x24 keeps the compact mark because the columns are below 48", () => {
  const rendered = render(44, 24);
  expect(rendered.startsWith("( Z )")).toBe(true);
  expect(rendered).toContain("Zhivex Code 0.3.0-rc.8");
  expect(rendered).not.toContain(mark[0]);
});

test("48 columns and 24 rows is the minimum that shows the logo", () => {
  expect(render(47, 24).startsWith("( Z )")).toBe(true);
  const lines = render(48, 24).split("\n");
  expect(lines.slice(0, 10)).toEqual(mark);
  // 48 is one cell short of logo + gap + title, so the header stacks under the mark.
  expect(lines[10]).toBe("Zhivex Code 0.3.0-rc.8");
  expect(lines.at(-1)).toBe("session greeting");
});

test("a dumb terminal, a non-TTY, or compact mode keeps the mark", () => {
  expect(render(80, 30, { term: "dumb" }).startsWith("( Z )")).toBe(true);
  expect(render(80, 30, { tty: false }).startsWith("( Z )")).toBe(true);
  expect(render(100, 40, { compact: true }).startsWith("( Z )")).toBe(true);
  expect(render(80, 30).split("\n").map(line => line.slice(0, 24))).toEqual(mark);
});

test("NO_COLOR keeps the glyph and omits escapes", () => {
  const plain = render(80, 24);
  expect(plain.includes("\u001b")).toBe(false);
  expect(plain).toContain(mark[0]);
  const colored = render(80, 24, { color: true });
  expect(colored).toContain("\u001b[31m");
  expect(colored).toContain(mark[0]);
});

test("ten-row logo, composer, header and footer occupancy at 24 rows", () => {
  const composerFor = (columns: number) => formatComposer({
    model: "openai/gpt-5.6-luna",
    reasoning: "default",
    status: "approval pending · /pending to review",
    contextTokens: 0,
    attachments: 0,
    nextLimitUsd: null,
  }, columns, false);
  // Welcome, then the Ready line and the approval-mode line, then the composer.
  const startupLines = 2;
  const occupy = (columns: number) => {
    const welcome = render(columns, 24).split("\n").length;
    // Composer string: leading blank, state, status, rule, and a trailing newline.
    const composerCommitted = composerFor(columns).split("\n").length - 1;
    // The prompt write adds one blank row and the "> " row.
    const promptRow = welcome + startupLines + composerCommitted + 2;
    const footerRows = formatComposerFooter(columns, false).length;
    return { welcome, composerCommitted, promptRow, withFooter: promptRow + footerRows };
  };

  const wide = occupy(80);
  expect(wide.welcome).toBe(10);
  expect(wide.composerCommitted).toBe(7);
  expect(wide.withFooter).toBe(23);

  const stacked = occupy(48);
  expect(stacked.welcome).toBe(15);
  expect(stacked.composerCommitted).toBe(7);
  expect(stacked.withFooter).toBe(28);
});
