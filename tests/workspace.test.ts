import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

    const read = await workspace.readFile("src/index.ts");
    expect(read.content).toContain("1: export const value = 1;");

    const searched = await workspace.searchFiles("VALUE");
    expect(searched.matches).toEqual([
      { path: "src/index.ts", line: 1, text: "export const value = 1;" }
    ]);
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
});
