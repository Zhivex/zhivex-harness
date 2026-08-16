import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEditProposal } from "../src/edit-contracts.js";
import { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

const run = async (command: string[], cwd: string) => {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8"
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
};

const writeFixtureFile = async (root: string, relativePath: string, contents: string) => {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
};

const createRepositoryFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-repository-e2e-"));
  temporaryDirectories.push(root);

  const scripts = {
    test: "bun -e \"console.log('fixture-test-ok')\"",
    lint: "bun -e \"console.error('fixture-lint-failed'); process.exit(7)\"",
    format: "bun -e \"console.log('fixture-format-ok')\""
  };
  await writeFixtureFile(root, "package.json", `${JSON.stringify({
    name: "repository-editing-fixture",
    private: true,
    type: "module",
    scripts
  }, null, 2)}\n`);
  await writeFixtureFile(root, ".gitignore", "ignored/\n*.generated\n!.env\n");
  await writeFixtureFile(root, ".zhivex-harnessignore", "private-notes/\n!.env\n");
  await writeFixtureFile(root, "src/.gitignore", "nested-ignored.ts\n");
  await writeFixtureFile(root, "src/index.ts", "export const fixtureValue = 1;\n");
  await writeFixtureFile(root, "src/restore-me.ts", "export const restored = true;\n");
  await writeFixtureFile(root, "src/delete-me.ts", "export const deleted = true;\n");
  await writeFixtureFile(root, "docs/old-name.md", "fixture rename target\n");
  await writeFixtureFile(root, "ignored/generated.ts", "fixture ignored\n");
  await writeFixtureFile(root, "private-notes/local.md", "fixture harness ignored\n");
  await writeFixtureFile(root, "src/nested-ignored.ts", "fixture nested ignored\n");
  await writeFixtureFile(root, ".env", "OPENAI_API_KEY=fixture-secret\n");
  await chmod(path.join(root, "src", "index.ts"), 0o755);

  await run(["git", "init", "--quiet"], root);
  await run(["git", "config", "user.name", "Zhivex Fixture"], root);
  await run(["git", "config", "user.email", "fixture@zhivex.invalid"], root);
  await run(["git", "config", "commit.gpgsign", "false"], root);
  await run(["git", "add", "."], root);
  await run(["git", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"], root);

  return { root, scripts, workspace: await Workspace.open(root) };
};

const listEveryFile = async (workspace: Workspace) => {
  const files: Awaited<ReturnType<Workspace["listFiles"]>>["files"] = [];
  let cursor: string | undefined;
  do {
    const page = await workspace.listFiles(".", {
      limit: 2,
      ...(cursor ? { cursor } : {})
    });
    files.push(...page.files);
    expect(page.truncated).toBe(Boolean(page.nextCursor));
    cursor = page.nextCursor;
  } while (cursor);
  return files;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("trusted repository editing fixture", () => {
  test("inspects, edits, validates, recovers, and summarizes a real Git repository", async () => {
    const { root, scripts, workspace } = await createRepositoryFixture();

    const firstListing = await listEveryFile(workspace);
    const secondListing = await listEveryFile(workspace);
    expect(firstListing).toEqual(secondListing);
    expect(firstListing.map((file) => file.path)).toEqual([
      ".gitignore",
      ".zhivex-harnessignore",
      "docs/old-name.md",
      "package.json",
      "src/.gitignore",
      "src/delete-me.ts",
      "src/index.ts",
      "src/restore-me.ts"
    ]);
    expect(firstListing.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.digest))).toBe(true);
    expect(firstListing.map((file) => file.path)).not.toContain("ignored/generated.ts");
    expect(firstListing.map((file) => file.path)).not.toContain("private-notes/local.md");
    expect(firstListing.map((file) => file.path)).not.toContain("src/nested-ignored.ts");
    expect(firstListing.map((file) => file.path)).not.toContain(".env");
    await expect(workspace.readFile(".env")).rejects.toThrow("harness policy");

    const firstSearch = await workspace.searchFiles("fixture", ".", { limit: 1 });
    expect(firstSearch.matches).toHaveLength(1);
    expect(firstSearch.truncated).toBe(true);
    const searchCursor = firstSearch.nextCursor;
    expect(typeof searchCursor).toBe("string");
    if (!searchCursor) {
      throw new Error("Expected the first search page to provide nextCursor.");
    }
    const secondSearch = await workspace.searchFiles("fixture", ".", {
      limit: 1,
      cursor: searchCursor
    });
    expect(secondSearch.matches[0]).not.toEqual(firstSearch.matches[0]);
    await expect(workspace.searchFiles("different", ".", {
      limit: 1,
      cursor: searchCursor
    })).rejects.toThrow(/cursor/i);

    const inspectedIndex = await workspace.readFile("src/index.ts");
    const changes = [
      {
        path: "src/index.ts",
        expectedDigest: inspectedIndex.digest,
        content: "export const fixtureValue = 2;\n"
      },
      {
        path: "src/new.ts",
        expectedDigest: null,
        content: "export const fixtureNew = true;\n"
      }
    ];
    const proposal = createEditProposal({ changes });
    const applied = await workspace.applyPatch({ proposalId: proposal.proposalId, changes });
    expect(applied.proposalId).toBe(proposal.proposalId);
    expect(applied.changes.map((entry) => entry.operation)).toEqual(["update", "create"]);
    expect((await stat(path.join(root, "src", "index.ts"))).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(root, "src", "new.ts"), "utf8")).toContain("fixtureNew");

    await run(["git", "add", "src/index.ts"], root);
    const stagedIndex = await workspace.readFile("src/index.ts");
    const followUp = [{
      path: "src/index.ts",
      expectedDigest: stagedIndex.digest,
      content: "export const fixtureValue = 3;\n"
    }];
    const followUpProposal = createEditProposal({ changes: followUp });
    await workspace.applyPatch({ proposalId: followUpProposal.proposalId, changes: followUp });

    const renameSource = await workspace.readFile("docs/old-name.md");
    const move = await workspace.moveFile({
      source: "docs/old-name.md",
      destination: "docs/new-name.md",
      expectedDigest: renameSource.digest
    });
    expect(move).toMatchObject({
      source: "docs/old-name.md",
      destination: "docs/new-name.md",
      audit: {
        operation: "move",
        path: "docs/old-name.md",
        destination: "docs/new-name.md"
      }
    });
    await run(["git", "add", "-A", "docs"], root);

    const recoverable = await workspace.readFile("src/restore-me.ts");
    const quarantined = await workspace.quarantineFile({
      path: "src/restore-me.ts",
      expectedDigest: recoverable.digest
    });
    expect(typeof quarantined.quarantineId).toBe("string");
    await expect(readFile(path.join(root, "src", "restore-me.ts"), "utf8")).rejects.toThrow();
    const restored = await workspace.restoreQuarantined({
      quarantineId: quarantined.quarantineId,
      expectedDigest: recoverable.digest
    });
    expect(restored).toMatchObject({
      quarantineId: quarantined.quarantineId,
      path: "src/restore-me.ts",
      audit: { operation: "restore" }
    });
    expect(await readFile(path.join(root, "src", "restore-me.ts"), "utf8")).toContain("restored");

    const deleteOnly = await workspace.readFile("src/delete-me.ts");
    await workspace.quarantineFile({
      path: "src/delete-me.ts",
      expectedDigest: deleteOnly.digest
    });

    const passingCheck = await workspace.runCheck("test", scripts.test, ["test", "lint"]);
    expect(passingCheck).toMatchObject({ exitCode: 0, timedOut: false });
    expect(passingCheck.stdout).toContain("fixture-test-ok");
    const failedCheck = await workspace.runCheck("lint", scripts.lint, ["test", "lint"]);
    expect(failedCheck.exitCode).toBe(7);
    expect(failedCheck.stderr).toContain("fixture-lint-failed");
    await expect(workspace.runCheck("format", scripts.format, ["test", "lint"]))
      .rejects.toThrow(/allow/i);

    const git = await workspace.gitDiff();
    expect(git.status.stdout).toContain("MM src/index.ts");
    expect(git.status.stdout).toContain("R  docs/old-name.md -> docs/new-name.md");
    expect(git.status.stdout).toContain(" D src/delete-me.ts");
    expect(git.status.stdout).toContain("?? src/new.ts");
    expect(git.diff.stdout).toContain("fixtureValue = 3");
    expect(git.staged.stdout).toContain("docs/old-name.md");
    expect(git.staged.stdout).toContain("docs/new-name.md");

    const operations = workspace.mutationAudit().map((entry) => entry.operation);
    expect(operations).toEqual([
      "update",
      "create",
      "update",
      "move",
      "quarantine",
      "restore",
      "quarantine"
    ]);
    const finalSummary = JSON.stringify({
      ...git,
      mutations: workspace.mutationAudit(),
      checks: [passingCheck, failedCheck]
    });
    for (const evidence of [
      "src/index.ts",
      "docs/new-name.md",
      "src/delete-me.ts",
      "src/new.ts",
      "fixture-lint-failed",
      "quarantine"
    ]) {
      expect(finalSummary).toContain(evidence);
    }
  });

  test("rejects stale multi-file, move, and restore operations without overwriting newer content", async () => {
    const { root, workspace } = await createRepositoryFixture();

    const inspected = await workspace.readFile("src/index.ts");
    const changes = [
      {
        path: "src/index.ts",
        expectedDigest: inspected.digest,
        content: "export const fixtureValue = 10;\n"
      },
      {
        path: "src/should-not-exist.ts",
        expectedDigest: null,
        content: "export const shouldNotExist = true;\n"
      }
    ];
    const proposal = createEditProposal({ changes });
    await writeFixtureFile(root, "src/index.ts", "export const externalChange = true;\n");

    await expect(workspace.applyPatch({ proposalId: proposal.proposalId, changes }))
      .rejects.toThrow(/digest|stale|changed/i);
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("externalChange");
    await expect(readFile(path.join(root, "src", "should-not-exist.ts"), "utf8")).rejects.toThrow();
    expect(workspace.mutationAudit()).toEqual([]);

    const moveSource = await workspace.readFile("docs/old-name.md");
    await writeFixtureFile(root, "docs/old-name.md", "external move conflict\n");
    await expect(workspace.moveFile({
      source: "docs/old-name.md",
      destination: "docs/moved.md",
      expectedDigest: moveSource.digest
    })).rejects.toThrow(/digest|stale|changed/i);
    await expect(readFile(path.join(root, "docs", "moved.md"), "utf8")).rejects.toThrow();

    const recoverable = await workspace.readFile("src/restore-me.ts");
    const quarantined = await workspace.quarantineFile({
      path: "src/restore-me.ts",
      expectedDigest: recoverable.digest
    });
    await writeFixtureFile(root, "src/restore-me.ts", "newer destination\n");
    await expect(workspace.restoreQuarantined({
      quarantineId: quarantined.quarantineId,
      expectedDigest: recoverable.digest
    })).rejects.toThrow(/exist|overwrite|destination/i);
    expect(await readFile(path.join(root, "src", "restore-me.ts"), "utf8")).toBe("newer destination\n");

    const restoredElsewhere = await workspace.restoreQuarantined({
      quarantineId: quarantined.quarantineId,
      destination: "recovered/restore-me.ts",
      expectedDigest: recoverable.digest
    });
    expect(restoredElsewhere).toMatchObject({
      quarantineId: quarantined.quarantineId,
      path: "recovered/restore-me.ts",
      audit: { operation: "restore" }
    });
    expect(await readFile(path.join(root, "recovered", "restore-me.ts"), "utf8")).toContain("restored");
  });
});
