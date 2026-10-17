import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { revealInvisible, revealInvisibleText } from "../src/review/reveal-invisible.js";

test("hidden diff characters stay visible and a second pass does not escape them again", () => {
  const line = "  if (command.includes(\"\0\"))\u200b\u202e\t ";
  const shown = revealInvisible(line);
  expect(shown.startsWith("  if")).toBe(true);
  expect(shown).toContain("\\0");
  expect(shown).toContain("\\u200B");
  expect(shown).toContain("\\u202e");
  expect(shown).toContain("→");
  expect(shown).toContain("·");
  expect(shown).not.toContain("\0");
  expect(shown).not.toContain("\u200b");
  expect(shown).not.toContain("\u202e");
  expect(revealInvisible(shown)).toBe(shown);
  expect(revealInvisibleText("a \nb\t\n")).toBe("a·\nb→\n");
});

test("literal escape sequences stay as written and only real control bytes are escaped", async () => {
  const literal = "command.indexOf(\"\\u0000\")";
  const realNul = "command.indexOf(\"\0\")";
  expect(literal).toContain("\\u0000");
  expect(literal.includes("\0")).toBe(false);
  expect(revealInvisible(literal)).toBe(literal);
  expect(revealInvisible(revealInvisible(literal))).toBe(literal);
  expect(revealInvisible(realNul)).toBe("command.indexOf(\"\\0\")");
  expect(revealInvisible(revealInvisible(realNul))).toBe("command.indexOf(\"\\0\")");
  expect(revealInvisible(literal)).not.toContain("^@");
  expect(revealInvisible(realNul)).not.toContain("^@");
  expect(revealInvisible(realNul)).not.toContain("\\u0000");
  expect(revealInvisibleText("context\r\nbefore\r\nlast")).toBe("context\r\nbefore\r\nlast");
  const desktop = await readFile(new URL("../desktop/src/reveal-invisible.ts", import.meta.url), "utf8");
  const shared = await readFile(new URL("../src/review/reveal-invisible.ts", import.meta.url), "utf8");
  expect(desktop).toBe(shared);
});
