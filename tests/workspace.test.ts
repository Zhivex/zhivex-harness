import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEditProposal } from "../src/edit-contracts.js";
import { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "ignored", "index.js"), "ignored", "utf8");
  return { root, workspace: await Workspace.open(root) };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Workspace", () => {
  test("lists, reads, and searches bounded text files", async () => {
    const { workspace } = await fixture();
    const listed = await workspace.listFiles();
    expect(listed.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(listed.files[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const read = await workspace.readFile("src/index.ts");
    expect(read.content).toContain("1: export const value = 1;");
    expect(read.digest).toBe(listed.files[0]?.digest);

    const searched = await workspace.searchFiles("VALUE");
    expect(searched.matches).toEqual([{
      path: "src/index.ts",
      line: 1,
      text: "export const value = 1;",
      digest: read.digest
    }]);
  });

  test("writes new files and replaces exactly one occurrence", async () => {
    const { workspace } = await fixture();
    await workspace.writeFile("src/new.ts", "export const created = true;\n");
    await workspace.replaceInFile("src/index.ts", "value = 1", "value = 2");

    expect((await workspace.readFile("src/new.ts")).content).toContain("created = true");
    expect((await workspace.readFile("src/index.ts")).content).toContain("value = 2");
    await expect(workspace.replaceInFile("src/index.ts", "missing", "x")).rejects.toThrow("0 occurrences");
  });

  test("blocks traversal, secrets, and symlink escape", async () => {
    const { root, workspace } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "outside-link"));
    await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=secret", "utf8");

    await expect(workspace.readFile("../secret.txt")).rejects.toThrow("escapes the workspace");
    await expect(workspace.readFile("outside-link/secret.txt")).rejects.toThrow("outside the workspace");
    await expect(workspace.writeFile("outside-link/new.txt", "nope")).rejects.toThrow("outside the workspace");
    await expect(workspace.readFile(".env")).rejects.toThrow("harness policy");
    expect((await workspace.listFiles()).files.map((file) => file.path)).not.toContain(".env");
  });

  test("runs only declared Bun checks", async () => {
    const { root, workspace } = await fixture();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "bun -e \"console.log('CHECK_OK')\"" } }),
      "utf8"
    );

    const script = "bun -e \"console.log('CHECK_OK')\"";
    const result = await workspace.runCheck("typecheck", script);
    expect(result.command).toEqual(["bun", "--no-env-file", "run", "typecheck"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CHECK_OK");
    await expect(workspace.runCheck("typecheck", "different")).rejects.toThrow("expectedScript");
    await expect(workspace.runCheck("build", "bun build")).rejects.toThrow('does not define the "build" script');
  });

  test("respects Git and harness ignore rules while hard secret rules remain non-negotiable", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, ".gitignore"), "ignored/\n*.log\n!.keep.log\n!.ENV\n", "utf8");
    await writeFile(path.join(root, ".zhivex-harnessignore"), "src/private.ts\n", "utf8");
    await writeFile(path.join(root, ".keep.log"), "visible\n", "utf8");
    await writeFile(path.join(root, ".ENV"), "SECRET=hidden\n", "utf8");
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored", "hidden.ts"), "hidden\n", "utf8");
    await writeFile(path.join(root, "src", ".gitignore"), "nested-ignore.ts\n", "utf8");
    await writeFile(path.join(root, "src", "nested-ignore.ts"), "hidden\n", "utf8");
    await writeFile(path.join(root, "src", "private.ts"), "hidden\n", "utf8");

    expect((await workspace.listFiles()).files.map((file) => file.path)).toEqual([
      ".gitignore",
      ".keep.log",
      ".zhivex-harnessignore",
      "src/.gitignore",
      "src/index.ts"
    ]);
    await expect(workspace.readFile(".ENV")).rejects.toThrow("harness policy");
  });

  test("paginates list and search results deterministically with request-bound cursors", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "src", "a.ts"), "needle a\nneedle a2\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), "needle b\n", "utf8");
    await writeFile(path.join(root, "src", "c.ts"), "needle c\n", "utf8");

    const firstList = await workspace.listFiles("src", { limit: 2 });
    expect(firstList.truncated).toBe(true);
    expect(firstList.nextCursor).toBeString();
    const secondList = await workspace.listFiles("src", { limit: 2, cursor: firstList.nextCursor });
    expect(secondList.truncated).toBe(false);
    expect([...firstList.files, ...secondList.files].map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/index.ts"
    ]);
    await expect(workspace.listFiles("src", { limit: 3, cursor: firstList.nextCursor })).rejects.toThrow("cursor");

    const firstSearch = await workspace.searchFiles("needle", "src", { limit: 2 });
    expect(firstSearch.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
    const secondSearch = await workspace.searchFiles("needle", "src", { limit: 2, cursor: firstSearch.nextCursor });
    expect(secondSearch.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["src/b.ts:1", "src/c.ts:1"]);
    await expect(workspace.searchFiles("different", "src", { limit: 2, cursor: firstSearch.nextCursor })).rejects.toThrow("cursor");
  });

  test("reuses one versioned index across pages and rebuilds it after structural changes", async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, "bulk"));
    await Promise.all(Array.from({ length: 120 }, (_, index) =>
      writeFile(path.join(root, "bulk", `${index.toString().padStart(3, "0")}.txt`), `file ${index}\n`, "utf8")));
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "a.ts"), "flat\n", "utf8");
    await writeFile(path.join(root, "a", "nested.ts"), "nested\n", "utf8");

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await workspace.listFiles(".", { limit: 11, ...(cursor ? { cursor } : {}) });
      collected.push(...page.files.map((file) => file.path));
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual([...collected].sort());
    expect(collected).toContain("a.ts");
    expect(collected).toContain("a/nested.ts");
    const indexed = workspace.workspaceIndexDiagnostics();
    expect(indexed.builds).toBe(1);
    expect(indexed.reuses).toBeGreaterThan(1);
    expect(indexed.files).toBe(collected.length);

    const stalePage = await workspace.listFiles("bulk", { limit: 5 });
    await writeFile(path.join(root, "bulk", "999.txt"), "added later\n", "utf8");
    await expect(workspace.listFiles("bulk", { limit: 5, cursor: stalePage.nextCursor })).rejects.toThrow(/cursor|stale/);
    expect(workspace.workspaceIndexDiagnostics().builds).toBe(2);
    expect((await workspace.listFiles("bulk", { limit: 500 })).files.at(-1)?.path).toBe("bulk/999.txt");
  });

  test("refreshes ignore rules and never follows a symlink introduced after indexing", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, ".gitignore"), "src/hidden-a.ts\n", "utf8");
    await writeFile(path.join(root, "src", "hidden-a.ts"), "hidden a\n", "utf8");
    await writeFile(path.join(root, "src", "hidden-b.ts"), "hidden b\n", "utf8");
    const first = await workspace.listFiles();
    expect(first.files.map((file) => file.path)).not.toContain("src/hidden-a.ts");

    await writeFile(path.join(root, ".gitignore"), "src/hidden-b.ts\n", "utf8");
    const refreshed = await workspace.listFiles();
    expect(refreshed.files.map((file) => file.path)).toContain("src/hidden-a.ts");
    expect(refreshed.files.map((file) => file.path)).not.toContain("src/hidden-b.ts");

    const outside = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-index-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "do not read\n", "utf8");
    await rm(path.join(root, "src", "hidden-a.ts"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "src", "hidden-a.ts"));
    expect((await workspace.listFiles()).files.map((file) => file.path)).not.toContain("src/hidden-a.ts");
  });

  test("invalidates active cursors after mutations committed through Workspace", async () => {
    const { workspace } = await fixture();
    await workspace.writeFile("src/a.ts", "a\n");
    await workspace.writeFile("src/b.ts", "b\n");
    const first = await workspace.listFiles("src", { limit: 1 });
    expect(first.nextCursor).toBeString();
    expect(workspace.workspaceIndexDiagnostics().version).toBeString();

    await workspace.writeFile("src/c.ts", "c\n");
    expect(workspace.workspaceIndexDiagnostics().version).toBeUndefined();
    await expect(workspace.listFiles("src", { limit: 1, cursor: first.nextCursor })).rejects.toThrow(/cursor|stale/);
    expect((await workspace.listFiles("src", { limit: 20 })).files.map((file) => file.path)).toContain("src/c.ts");
  });

  test("batches reads deterministically and reads duplicate ranges from one stable snapshot", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "src", "a.ts"), "first\nsecond\nthird\n", "utf8");
    const before = workspace.workspaceIndexDiagnostics().stableFileReads;

    const batch = await workspace.readFiles([
      { path: "src/index.ts" },
      { path: "src/a.ts", startLine: 2, endLine: 2 },
      { path: "src/a.ts", startLine: 1, endLine: 1 }
    ]);

    expect(batch.files.map((file) => `${file.path}:${file.startLine}`)).toEqual([
      "src/a.ts:1",
      "src/a.ts:2",
      "src/index.ts:1"
    ]);
    expect(batch.files[0]?.content).toContain("1: first");
    expect(workspace.workspaceIndexDiagnostics().stableFileReads - before).toBe(2);
    await expect(workspace.readFiles(Array.from({ length: 21 }, () => ({ path: "src/index.ts" })))).rejects.toThrow("between 1 and 20");

    const large = "x".repeat(700 * 1024);
    await Promise.all(["large-a.txt", "large-b.txt", "large-c.txt"].map((name) =>
      writeFile(path.join(root, "src", name), large, "utf8")));
    await expect(workspace.readFiles([
      { path: "src/large-a.txt" },
      { path: "src/large-b.txt" },
      { path: "src/large-c.txt" }
    ])).rejects.toThrow("aggregate");
  });

  test("searches multiple needles in one deterministic content pass with aggregate limits", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "src", "a.ts"), "alpha beta\nalpha\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), "BETA\n", "utf8");
    await workspace.listFiles();
    const before = workspace.workspaceIndexDiagnostics();

    const batch = await workspace.searchMany([
      { query: "alpha", caseSensitive: true },
      { query: "beta" }
    ], "src", { limitPerQuery: 2 });

    expect(batch.results[0]?.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
    expect(batch.results[1]?.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["src/a.ts:1", "src/b.ts:1"]);
    expect(workspace.workspaceIndexDiagnostics().stableFileReads - before.stableFileReads).toBe(3);
    await expect(workspace.searchMany(
      Array.from({ length: 10 }, (_, index) => ({ query: `q${index}` })),
      ".",
      { limitPerQuery: 51 }
    )).rejects.toThrow("aggregate");
  });

  test("applies digest-bound multi-file patches atomically and preserves modes", async () => {
    const { root, workspace } = await fixture();
    await chmod(path.join(root, "src", "index.ts"), 0o751);
    const before = await workspace.readFile("src/index.ts");
    const changes = [
      { path: "src/index.ts", expectedDigest: before.digest, content: "export const value = 2;\n" },
      { path: "src/created.ts", expectedDigest: null, content: "export const created = true;\n" }
    ];
    const proposal = createEditProposal({ changes });

    const result = await workspace.applyPatch({ proposalId: proposal.proposalId, changes });

    expect(result.changes.map((entry) => entry.operation)).toEqual(["update", "create"]);
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("value = 2");
    expect((await stat(path.join(root, "src", "index.ts"))).mode & 0o777).toBe(0o751);
    expect(workspace.mutationAudit()).toHaveLength(2);

    await expect(workspace.applyPatch({ proposalId: proposal.proposalId, changes })).rejects.toThrow(/Stale|already exists/);
    const current = await workspace.readFile("src/index.ts");
    const conflictingChanges = [
      { path: "src/index.ts", expectedDigest: current.digest, content: "must roll back\n" },
      { path: "src/created.ts", expectedDigest: null, content: "conflict\n" }
    ];
    const conflict = createEditProposal({ changes: conflictingChanges });
    await expect(workspace.applyPatch({ proposalId: conflict.proposalId, changes: conflictingChanges })).rejects.toThrow("already exists");
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("value = 2");
  });

  test("cleans staged files and leaves no audit when a later target cannot be prepared", async () => {
    const { root, workspace } = await fixture();
    const changes = [
      { path: "src/a-created.ts", expectedDigest: null, content: "staged only\n" },
      { path: `src/${"z".repeat(300)}.ts`, expectedDigest: null, content: "too long\n" }
    ];
    const proposal = createEditProposal({ changes });

    await expect(workspace.applyPatch({ proposalId: proposal.proposalId, changes })).rejects.toThrow();

    await expect(readFile(path.join(root, "src", "a-created.ts"), "utf8")).rejects.toThrow();
    expect((await readdir(path.join(root, "src"))).filter((name) => name.includes(".zhivex-") && name.endsWith(".tmp"))).toEqual([]);
    expect(workspace.mutationAudit()).toEqual([]);
  });

  test("moves, quarantines, and restores without overwriting destinations", async () => {
    const { root, workspace } = await fixture();
    await chmod(path.join(root, "src", "index.ts"), 0o750);
    const original = await workspace.readFile("src/index.ts");
    const moved = await workspace.moveFile({
      source: "src/index.ts",
      destination: "src/moved.ts",
      expectedDigest: original.digest
    });
    expect(moved.digest).toBe(original.digest);
    await expect(readFile(path.join(root, "src", "index.ts"), "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "src", "occupied.ts"), "occupied\n", "utf8");
    await expect(workspace.moveFile({
      source: "src/moved.ts",
      destination: "src/occupied.ts",
      expectedDigest: original.digest
    })).rejects.toThrow("already exists");
    expect(await readFile(path.join(root, "src", "occupied.ts"), "utf8")).toBe("occupied\n");

    const quarantined = await workspace.quarantineFile({ path: "src/moved.ts", expectedDigest: original.digest });
    await expect(readFile(path.join(root, "src", "moved.ts"), "utf8")).rejects.toThrow();
    expect((await workspace.listFiles()).files.some((file) => file.path.includes(quarantined.quarantineId))).toBe(false);

    await writeFile(path.join(root, "src", "moved.ts"), "new occupant\n", "utf8");
    await expect(workspace.restoreQuarantined({ quarantineId: quarantined.quarantineId })).rejects.toThrow("already exists");
    expect(await readFile(path.join(root, "src", "moved.ts"), "utf8")).toBe("new occupant\n");

    const restored = await workspace.restoreQuarantined({
      quarantineId: quarantined.quarantineId,
      destination: "src/restored.ts",
      expectedDigest: original.digest
    });
    expect(restored.digest).toBe(original.digest);
    expect((await stat(path.join(root, "src", "restored.ts"))).mode & 0o777).toBe(0o750);
    await expect(workspace.restoreQuarantined({ quarantineId: quarantined.quarantineId })).rejects.toThrow("not restorable");
    expect(workspace.mutationAudit().map((entry) => entry.operation)).toEqual(["move", "quarantine", "restore"]);
  });

  test("runs custom checks only when explicitly allowed", async () => {
    const { root, workspace } = await fixture();
    const script = "bun -e \"console.log('FAST_OK')\"";
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "verify:fast": script } }), "utf8");

    await expect(workspace.runCheck("verify:fast", script)).rejects.toThrow("allowlist");
    const result = await workspace.runCheck("verify:fast", script, ["verify:fast"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FAST_OK");
  });
});
