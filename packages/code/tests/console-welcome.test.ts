import { expect, test } from "bun:test";
import { formatComposer, formatComposerFooter, consoleStatusText } from "../src/cli/console/console-presentation.js";
import { formatConsoleWelcome, ZHIVEX_TERMINAL_LOGO } from "../src/cli/console/console-welcome.js";
import { terminalSupportsColor } from "../src/cli/terminal/terminal-ui.js";

const input = {
  version: "0.3.0-rc.8",
  workspace: "/tmp/project",
  sessionId: "ses_should_not_appear",
  sessionTitle: "greeting",
  provider: "openai",
  model: "gpt-5.6-luna",
};

const policy = "Zhivex asks before it changes files.";
const render = (columns: number, rows: number, extra: { tty?: boolean; term?: string; compact?: boolean; color?: boolean; restored?: boolean; workspace?: string } = {}) =>
  formatConsoleWelcome({ ...input, ...(extra.workspace ? { workspace: extra.workspace } : {}) }, {
    layout: "code", color: false, tty: true, term: "xterm-256color", columns, rows, policy, ...extra,
  });

const mark = ZHIVEX_TERMINAL_LOGO.split("\n");
const braille = /[\u2800-\u28FF]/;

test("the mark is ten rows of the sampled logo", () => {
  expect(mark).toHaveLength(10);
  expect(mark.every(line => line.length === 24)).toBe(true);
  expect(mark[0] ?? "").toContain("⣀⣤⣴");
});

test("80 columns and 24 rows place the logo beside the title and project", () => {
  const lines = render(80, 24).split("\n");
  expect(lines).toHaveLength(10);
  expect(lines.map(line => line.slice(0, 24))).toEqual(mark);
  expect(lines.join("\n")).not.toContain("( Z )");
  expect(lines[2]).toContain("Zhivex Code 0.3.0-rc.8");
  expect(lines[3]).toContain("/tmp/project · openai/gpt-5.6-luna");
  expect(lines.join("\n")).toContain("Welcome. What would you like to work on?");
  expect(lines.join("\n")).toContain(policy);
  expect(lines.join("\n")).not.toContain("ses_should_not_appear");
  expect(lines.join("\n")).not.toContain("session ");
});

test("under 48 columns the first line is the compact mark and contains no braille", () => {
  const rendered = render(44, 30);
  expect(rendered.startsWith("( Z ) Zhivex Code 0.3.0-rc.8")).toBe(true);
  expect(rendered).toContain("/tmp/project · openai/gpt-5.6-luna");
  expect(braille.test(rendered)).toBe(false);
});

test("fewer than 24 rows, a non-TTY, or TERM=dumb uses the compact mark", () => {
  for (const rendered of [render(80, 23), render(80, 30, { tty: false }), render(100, 40, { term: "dumb" }), render(100, 40, { compact: true })]) {
    expect(rendered.startsWith("( Z )")).toBe(true);
    expect(braille.test(rendered)).toBe(false);
  }
  expect(render(80, 30).split("\n").map(line => line.slice(0, 24))).toEqual(mark);
});

test("48 columns and 24 rows is the minimum that shows the logo", () => {
  expect(render(47, 24).startsWith("( Z )")).toBe(true);
  const lines = render(48, 24).split("\n");
  expect(lines.slice(0, 10)).toEqual(mark);
  expect(lines[10]).toBe("Zhivex Code 0.3.0-rc.8");
  expect(lines.at(-1)).toBe(policy);
});

test("color false and NO_COLOR emit no escapes", () => {
  const plain = render(80, 24);
  expect(plain.includes("\u001b")).toBe(false);
  expect(plain).toContain(mark[0] ?? "");
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const uncolored = formatConsoleWelcome(input, {
      layout: "code", tty: true, term: "xterm-256color", columns: 80, rows: 24, policy,
      color: terminalSupportsColor(true),
    });
    expect(uncolored.includes("\u001b")).toBe(false);
    expect(uncolored).toContain(mark[0] ?? "");
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
  const colored = render(80, 24, { color: true });
  expect(colored).toContain("\u001b[31m");
  expect(colored).toContain(mark[0] ?? "");
});

test("project metadata with escapes is shown literally", () => {
  const rendered = render(80, 24, { workspace: "/tmp/proj\u001b[2Ject" });
  expect(rendered.includes("\u001b")).toBe(false);
  expect(rendered).toContain("\\u001b[2J");
});

test("a restored session prints no logo", () => {
  const home = process.env.HOME ?? "/home/ubuntu";
  const restored = render(100, 30, { restored: true, workspace: `${home}/project` });
  expect(restored).toBe("( Z ) Zhivex Code 0.3.0-rc.8 · ~/project · openai/gpt-5.6-luna");
  expect(braille.test(restored)).toBe(false);
});

test("a call without the code layout keeps the service welcome", () => {
  const legacy = formatConsoleWelcome({
    version: "0.3.0-rc.8", workspace: "/tmp/project", sessionId: "s", service: true,
  }, { columns: 80, color: false });
  const lines = legacy.split("\n");
  expect(lines).toHaveLength(12);
  expect(lines[0]).toBe("⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀");
  expect(lines[11]).toBe(lines[0]);
  expect(legacy).toContain("Runtime: local service · managed by host");
  expect(legacy).toContain("session s");
  expect(legacy).toContain("Project: /tmp/project");
});

const visualRows = (text: string, columns: number) =>
  text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil([...line].length / columns)), 0);

test("ten-row logo, composer and footer fit in 24 rows at 80 columns", () => {
  const state = { model: "openai/gpt-5.6-luna", status: "ready" as const };
  const occupy = (columns: number, rows: number) => {
    const welcome = render(columns, rows).split("\n").length;
    const composer = formatComposer(state, columns, false, "focus").split("\n").filter((_, index, all) => index < all.length - 1).length;
    const footer = formatComposerFooter(columns, false, state).length;
    return { welcome, composer, prompt: 1, footer, total: welcome + composer + 1 + footer };
  };
  const wide = occupy(80, 24);
  expect(wide.welcome).toBe(10);
  expect(consoleStatusText(state)).toBe("openai/gpt-5.6-luna · ask before changes · ready");
  expect(wide.total).toBeLessThanOrEqual(24);
  const stacked = occupy(48, 24);
  expect(stacked.welcome).toBe(15);
  expect(stacked.total).toBeLessThanOrEqual(24);
  expect(visualRows(render(44, 24), 44)).toBeLessThan(24);
});
