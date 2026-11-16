import { expect, test } from "bun:test";
import { formatFileDiff } from "../src/cli/terminal/file-diff.js";
import { changeSummary, renderReviewedDiff } from "../src/cli/console/review-diff.js";
import { reviewFrame } from "../src/cli/console/console-review.js";

const before = `${"kept\n".repeat(8)}if (!rootDir) return;\n${"tail\n".repeat(6)}`;
const after = `${"kept\n".repeat(8)}if (!rootDir) {\n  throw new ConfigurationError("rootDir is required");\n}\n${"tail\n".repeat(6)}`;

test("the review names the intent, counts each file, and keeps indentation when a line wraps", () => {
  const diff = formatFileDiff({ path: "packages/azure-openai/src/index.ts", before, after });
  expect(diff).toContain("··· ");
  expect(diff).toContain("unchanged lines");
  const full = formatFileDiff({ path: "packages/azure-openai/src/index.ts", before, after }, Number.POSITIVE_INFINITY);
  expect(full).not.toContain("unchanged lines");
  expect(full).toContain("throw new ConfigurationError");
  const summary = changeSummary({
    name: "apply_reviewed_replacement",
    arguments: JSON.stringify({ path: "packages/azure-openai/src/index.ts", intent: "The shell tool should fail when rootDir is missing." }),
  }, diff);
  expect(summary).toContain("shell tool should fail when rootDir is missing");
  const inferred = changeSummary({ name: "apply_reviewed_edits", arguments: JSON.stringify({ changes: [{ path: "packages/azure-openai/src/index.ts" }] }) }, diff);
  expect(inferred).toContain("rootDir is required");
  const rendered = renderReviewedDiff(diff, 48);
  expect(rendered.hunks.length).toBeGreaterThan(0);
  expect(rendered.lines.some(line => /^\s+\d+/.test(line) || /\d+\s+\d+/.test(line) || /\d+\s{6}/.test(line))).toBe(true);
  expect(rendered.lines.some(line => line.includes("«"))).toBe(true);
  const wrapped = rendered.lines.find(line => line.includes("ConfigurationError"));
  expect(wrapped?.includes("  throw") || rendered.lines.some(line => line.trimStart().startsWith("throw") && line.includes("  "))).toBe(true);
  const frame = reviewFrame({
    title: "Waiting for your decision",
    summary,
    fileList: "packages/azure-openai/src/index.ts  +2 −1",
    body: diff,
    files: 1,
  }, [
    { label: "Reject", key: "r", index: 0, detail: "This change is not applied." },
    { label: "Approve this change", key: "a", index: 1, detail: "Apply only the change shown above, once." },
    { label: "Show full diff", key: "f", index: 2, detail: "Show unchanged lines around this change." },
    { label: "Decide later", key: "Esc", index: 3, detail: "Leave it pending. Nothing is applied." },
  ], -1, "", 0, 80, 24, rendered.lines.slice(0, 6));
  const text = frame.lines.join("\n");
  expect(text).toContain("The shell tool should fail when rootDir is missing.");
  expect(text).toContain("+2 −1");
  expect(text).toContain("Approve this change");
  expect(text).toContain("Show full diff");
  expect(text).not.toContain("> a");
  expect(text).not.toContain("> r");
  expect(frame.lines.length).toBeLessThan(24);
  const long = "x".repeat(80);
  const wrappedIndent = renderReviewedDiff(`@@ -1,1 +1,1 @@\n-    ${long}\n+    ${long}!`, 40);
  const continuation = wrappedIndent.lines.find((line, index) => index > 0 && line.startsWith(" ".repeat(16)));
  expect(continuation).toBeTruthy();
  const wide = renderReviewedDiff(`@@ -1,1 +1,1 @@\n-    ${"word ".repeat(20)}\n+    ${"other ".repeat(20)}{`, 36);
  const brace = renderReviewedDiff(`@@ -1,1 +1,1 @@\n-    if (ready) {\n+    if (rootDir === undefined || rootDir === "") {`, 48);
  for (const line of [...wide.lines, ...brace.lines]) {
    expect((line.match(/«/g) ?? []).length).toBe((line.match(/»/g) ?? []).length);
    expect(line).not.toContain("«»");
  }
  expect(wide.lines.some(line => line.includes("«") && line.includes("»"))).toBe(true);
  const nul = formatFileDiff({
    path: "packages/azure-openai/src/index.ts",
    before: '    if (command.includes("\0")) {\n',
    after: '    if (command.indexOf("ok") !== -1) {\n',
  });
  expect(nul).toContain('includes("\\0")');
  expect(nul).not.toContain("\0");
  const hidden = renderReviewedDiff(nul, 80);
  expect(hidden.lines.join("\n")).toContain("\\0");
  expect(hidden.lines.join("\n")).not.toContain("\0");
  const spaced = renderReviewedDiff("@@ -1,1 +1,1 @@\n-keep\t \n+keep\u200B\u202e\n", 80);
  const spacedText = spaced.lines.join("\n");
  expect(spacedText).toContain("→");
  expect(spacedText).toContain("·");
  expect(spacedText).toContain("\\u200B");
  expect(spacedText).toContain("\\u202e");
  expect(spacedText).not.toContain("\u200B");
  expect(spacedText).not.toContain("\u202e");
  const short = reviewFrame({ title: "Waiting for your decision", body: Array.from({ length: 7 }, () => " line").join("\n"), files: 1 }, [
    { label: "Reject", key: "r", index: 0 },
    { label: "Approve this change", key: "a", index: 1 },
  ], -1, "", 0, 80, 40);
  const marker = short.lines.findIndex(line => line.includes("End of changes"));
  expect(short.lines.length).toBeLessThan(40);
  expect(short.lines[marker - 1]?.trim()).not.toBe("");
  expect(short.lines[marker + 1]).toContain("Waiting for your decision");
  const greeting = renderReviewedDiff("--- greeting.mjs\n+++ greeting.mjs\n@@ -1,1 +1,1 @@\n-export const greeting = (name) => `Hi, ${name}`;\n+export const greeting = (name) => `Hello, ${name}!`;\n", 100);
  const greetingText = greeting.lines.join("\n");
  expect(greetingText).toContain("---");
  expect(greetingText).toContain("+++");
  expect(greetingText).toContain("-export const greeting");
  expect(greetingText).toContain("+export const greeting");
  const literal = "command.indexOf(\"\\u0000\")";
  const escaped = renderReviewedDiff(`@@ -1,1 +1,1 @@\n-${literal}\n+command.indexOf(\"\0\")\n`, 120);
  const escapedText = escaped.lines.join("\n");
  expect(escapedText).toContain(literal);
  expect(escapedText).toContain("command.indexOf(\"\\0\")");
  expect(escapedText).not.toContain("^@");
  expect(escapedText).not.toContain("\\\\u0000");
});
