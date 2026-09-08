import { expect, test } from "bun:test";
import { TerminalMarkdown } from "../src/terminal-markdown.js";

test("renders fragmented headings and fenced code without terminal injection", () => {
  let output = "";
  const renderer = new TerminalMarkdown((text) => { output += text; }, true);
  for (const delta of ["## Su", "mmary\n```js\n", "const x = '\u001b", "[2J';\n```\n**Done**", " with `x`."]) renderer.write(delta);
  renderer.flush();
  expect(output).toContain("\u001b[1mSummary\u001b[0m");
  expect(output).toContain("\\u001b[2J");
  expect(output).not.toContain("\u001b[2J");
  expect(output).toContain("\u001b[1mDone\u001b[0m");
});

test("bounds unfinished lines and honors no-color output", () => {
  let output = "";
  const renderer = new TerminalMarkdown((text) => { output += text; }, false);
  renderer.write("x".repeat(2048));
  expect(output.length).toBe(2048);
  renderer.write("\n# Heading\n`code`\n");
  renderer.flush();
  expect(output).toContain("Heading\n`code`");
  expect(output).not.toContain("\u001b");
});
