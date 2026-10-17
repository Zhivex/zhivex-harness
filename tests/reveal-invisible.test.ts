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
