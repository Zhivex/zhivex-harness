import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsoleAttachments, formatConsoleContext, formatConsoleDiff } from "../src/console-context.js";
import { createEmptyHarnessContextBundle } from "../src/context-engineering.js";
import { Workspace } from "../src/workspace.js";

describe("console context", () => {
  test("attachments exclude protected files, links, and stale bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-console-"));
    try {
      await writeFile(path.join(root, "example.ts"), "original\n");
      await writeFile(path.join(root, ".env"), "DO_NOT_SEND=secret");
      await symlink(path.join(root, ".env"), path.join(root, "link.txt"));
      const workspace = await Workspace.open(root);
      const attachments = new ConsoleAttachments();
      await expect(attachments.add(workspace, ".env")).rejects.toThrow();
      await expect(attachments.add(workspace, "link.txt")).rejects.toThrow();
      await expect(attachments.add(workspace, "../outside.txt")).rejects.toThrow();
      await attachments.add(workspace, "example.ts");
      expect(await attachments.prompt(workspace, "review")).toContain("original");
      await writeFile(path.join(root, "example.ts"), "changed\n");
      await expect(attachments.prompt(workspace, "review")).rejects.toThrow("Attachment changed");
      await attachments.add(workspace, "example.ts");
      expect(await attachments.prompt(workspace, "review")).toContain("changed");
      attachments.clear();
      expect(await attachments.prompt(workspace, "review")).toBe("review");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("limits attachment count without changing the existing selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-console-limit-"));
    try {
      const workspace = await Workspace.open(root);
      const attachments = new ConsoleAttachments();
      for (let index = 0; index < 9; index++) await writeFile(path.join(root, `${index}.txt`), "data");
      for (let index = 0; index < 8; index++) await attachments.add(workspace, `${index}.txt`);
      await expect(attachments.add(workspace, "8.txt")).rejects.toThrow("8 files");
      expect(attachments.list()).toHaveLength(8);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("renders metadata without file contents or terminal escape injection", () => {
    const context = createEmptyHarnessContextBundle();
    context.sources = [{ scope: "project", kind: "rule", path: "evil\u001b[2J.md", digest: context.fingerprint, bytes: 5, content: "hidden-content" }];
    const output = formatConsoleContext(context);
    expect(output).toContain("\\u001b");
    expect(output).not.toContain("hidden-content");
    const diff = "+new\u001b[2J\n-old\n@@ 1 @@";
    expect(formatConsoleDiff(diff, false)).not.toContain("\u001b");
    expect(formatConsoleDiff(diff, true)).toContain("\u001b[32m+new\\u001b[2J\u001b[0m");
  });
});
