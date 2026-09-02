import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { createEditProposal } from "../src/edit-contracts.js";
import { readRegularFileNoFollow } from "../src/file-security.js";
import { createHarness, runHarness } from "../src/harness.js";
import { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceFixture = async () => {
  const root = await temporaryDirectory("zhivex-harness-security-");
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return { root, workspace: await Workspace.open(root) };
};

const runGit = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("security regressions", () => {
  test("binds stable reads to a regular non-symlink file descriptor", async () => {
    const root = await temporaryDirectory("zhivex-harness-stable-read-");
    const regularPath = path.join(root, "artifact.bin");
    const linkedPath = path.join(root, "artifact-link.bin");
    await writeFile(regularPath, "trusted bytes\n", "utf8");
    await symlink(regularPath, linkedPath);

    const regular = await readRegularFileNoFollow(regularPath, {
      label: "Artifact",
      maxBytes: 1024
    });
    expect(regular.contents.toString("utf8")).toBe("trusted bytes\n");
    await expect(readRegularFileNoFollow(regularPath, {
      label: "Artifact",
      maxBytes: 4
    })).rejects.toThrow("4-byte limit");
    await expect(readRegularFileNoFollow(linkedPath, {
      label: "Artifact",
      maxBytes: 1024
    })).rejects.toThrow("symbolic link");

    const hardLinkedPath = path.join(root, "artifact-hard-link.bin");
    await link(regularPath, hardLinkedPath);
    await expect(readRegularFileNoFollow(regularPath, {
      label: "Artifact",
      maxBytes: 1024,
      requireSingleLink: true
    })).rejects.toThrow("regular file");
  });

  test("rejects unsafe durable-state targets before a run can write to them", async () => {
    const { root } = await workspaceFixture();
    const outside = await temporaryDirectory("zhivex-harness-state-outside-");
    const stateSymlink = path.join(root, "state-link");
    await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=do-not-read\n", "utf8");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await symlink(outside, stateSymlink);

    const modelInstance = createMockLanguageModel();
    const unsafeStateDirectories = [
      root,
      path.join(root, ".env"),
      path.join(root, ".git", "harness-runs"),
      stateSymlink
    ];

    for (const stateDirectory of unsafeStateDirectories) {
      await expect(createHarness({
        provider: "openai",
        workspace: root,
        stateDirectory,
        modelInstance
      })).rejects.toThrow(/state|directory|protected|symbolic|symlink/i);
    }

    expect(await readFile(path.join(root, ".env"), "utf8")).toBe("OPENAI_API_KEY=do-not-read\n");
  });

  test("blocks nested external symlinks for reads and writes", async () => {
    const { root, workspace } = await workspaceFixture();
    const outside = await temporaryDirectory("zhivex-harness-nested-link-");
    await writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8");
    await symlink(outside, path.join(root, "src", "nested", "external"));

    await expect(workspace.readFile("src/nested/external/secret.txt")).rejects.toThrow("outside the workspace");
    await expect(workspace.writeFile("src/nested/external/new.txt", "nope\n")).rejects.toThrow(
      "outside the workspace"
    );
    expect((await workspace.listFiles()).files.map((file) => file.path)).not.toContain(
      "src/nested/external/secret.txt"
    );
  });

  test("rejects directories and named pipes as text files", async () => {
    const { root, workspace } = await workspaceFixture();
    await mkdir(path.join(root, "src", "directory.txt"));
    const fifoPath = path.join(root, "src", "events.txt");
    const mkfifo = Bun.spawnSync(["mkfifo", fifoPath], { stderr: "pipe" });
    expect(mkfifo.exitCode).toBe(0);

    await expect(workspace.readFile("src/directory.txt")).rejects.toThrow("regular file");
    await expect(workspace.readFile("src/events.txt")).rejects.toThrow("regular file");
    expect((await workspace.listFiles()).files.map((file) => file.path)).not.toContain("src/events.txt");
  });

  test("never follows a symlinked harness quarantine directory", async () => {
    const { root, workspace } = await workspaceFixture();
    const outside = await temporaryDirectory("zhivex-harness-quarantine-outside-");
    await symlink(outside, path.join(root, ".zhivex-harness"));
    const source = await workspace.readFile("src/index.ts");

    await expect(workspace.quarantineFile({
      path: "src/index.ts",
      expectedDigest: source.digest
    })).rejects.toThrow(/symbolic link|symlink/i);

    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("value = 1");
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects a quarantined payload replaced by a symlink", async () => {
    const { root, workspace } = await workspaceFixture();
    const outside = await temporaryDirectory("zhivex-harness-quarantine-payload-");
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside\n", "utf8");
    const source = await workspace.readFile("src/index.ts");
    const quarantined = await workspace.quarantineFile({ path: "src/index.ts", expectedDigest: source.digest });
    const dataPath = path.join(root, ".zhivex-harness", "quarantine", `${quarantined.quarantineId}.data`);
    await rm(dataPath);
    await symlink(outsideFile, dataPath);

    await expect(workspace.restoreQuarantined({ quarantineId: quarantined.quarantineId })).rejects.toThrow();
    await expect(readFile(path.join(root, "src", "index.ts"), "utf8")).rejects.toThrow();
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  test("keeps quarantine payload recoverable when manifest update fails", async () => {
    const { root, workspace } = await workspaceFixture();
    const source = await workspace.readFile("src/index.ts");
    const quarantined = await workspace.quarantineFile({ path: "src/index.ts", expectedDigest: source.digest });
    const quarantineDirectory = path.join(root, ".zhivex-harness", "quarantine");
    const dataPath = path.join(quarantineDirectory, `${quarantined.quarantineId}.data`);
    await chmod(quarantineDirectory, 0o500);
    try {
      await expect(workspace.restoreQuarantined({
        quarantineId: quarantined.quarantineId,
        destination: "src/restored.ts"
      })).rejects.toThrow();
      await expect(readFile(path.join(root, "src", "restored.ts"), "utf8")).rejects.toThrow();
      expect(await readFile(dataPath, "utf8")).toContain("value = 1");
    } finally {
      await chmod(quarantineDirectory, 0o700);
    }
  });

  test("permits only one concurrent create when overwrite is false", async () => {
    const { root, workspace } = await workspaceFixture();
    const attempts = await Promise.allSettled([
      workspace.writeFile("src/race.txt", "first\n", false),
      workspace.writeFile("src/race.txt", "second\n", false)
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(["first\n", "second\n"]).toContain(await readFile(path.join(root, "src", "race.txt"), "utf8"));
  });

  test("a concurrent move conflict never deletes the winning destination", async () => {
    const { root, workspace } = await workspaceFixture();
    await writeFile(path.join(root, "src", "first.ts"), "first\n", "utf8");
    await writeFile(path.join(root, "src", "second.ts"), "second\n", "utf8");
    const first = await workspace.readFile("src/first.ts");
    const second = await workspace.readFile("src/second.ts");

    const attempts = await Promise.allSettled([
      workspace.moveFile({ source: "src/first.ts", destination: "src/winner.ts", expectedDigest: first.digest }),
      workspace.moveFile({ source: "src/second.ts", destination: "src/winner.ts", expectedDigest: second.digest })
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(["first\n", "second\n"]).toContain(await readFile(path.join(root, "src", "winner.ts"), "utf8"));
    const remainingSources = await Promise.allSettled([
      readFile(path.join(root, "src", "first.ts"), "utf8"),
      readFile(path.join(root, "src", "second.ts"), "utf8")
    ]);
    expect(remainingSources.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });

  test("truncates stdout and stderr from approved checks", async () => {
    const { root, workspace } = await workspaceFixture();
    const script = "bun -e \"process.stdout.write('o'.repeat(25000)); process.stderr.write('e'.repeat(25000))\"";
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: script } }), "utf8");

    const result = await workspace.runCheck("test", script);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("output truncated");
    expect(result.stderr).toContain("output truncated");
    expect(result.stdout.length).toBeLessThan(20_200);
    expect(result.stderr.length).toBeLessThan(20_500);
  });

  test("git diff excludes sensitive paths and disables repository-controlled command hooks", async () => {
    const { root, workspace } = await workspaceFixture();
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "public.txt"), "public baseline\n", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=baseline-secret\n", "utf8");
    await writeFile(path.join(root, ".env.example"), "SAFE=baseline\n", "utf8");
    await writeFile(path.join(root, ".gitattributes"), "*.inspect diff=probe\n", "utf8");
    await writeFile(path.join(root, "public.inspect"), "inspect baseline\n", "utf8");
    await writeFile(path.join(root, "nested", "private.pem"), "baseline-private-key\n", "utf8");
    runGit(root, "init", "--quiet");
    runGit(root, "config", "user.name", "Zhivex Fixture");
    runGit(root, "config", "user.email", "fixture@zhivex.invalid");
    runGit(root, "config", "commit.gpgsign", "false");
    runGit(root, "add", "-f", ".");
    runGit(root, "commit", "--quiet", "--no-gpg-sign", "-m", "baseline");

    await writeFile(path.join(root, "public.txt"), "public changed\n", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=changed-secret-canary\n", "utf8");
    await writeFile(path.join(root, ".env.example"), "SAFE=changed-example\n", "utf8");
    await writeFile(path.join(root, "public.inspect"), "inspect changed\n", "utf8");
    await writeFile(path.join(root, "nested", "private.pem"), "changed-private-canary\n", "utf8");
    await writeFile(path.join(root, ".npmrc"), "//registry.invalid/:_authToken=untracked-canary\n", "utf8");
    runGit(root, "add", "-f", ".env", ".env.example", "public.txt");

    const marker = path.join(root, "fsmonitor-executed");
    const fsmonitor = path.join(root, "fsmonitor.sh");
    await writeFile(fsmonitor, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    runGit(root, "config", "core.fsmonitor", fsmonitor);
    const textconvMarker = path.join(root, "textconv-executed");
    const textconv = path.join(root, "textconv.sh");
    await writeFile(textconv, `#!/bin/sh\nprintf executed > ${JSON.stringify(textconvMarker)}\nprintf converted\n`, { mode: 0o755 });
    runGit(root, "config", "diff.probe.textconv", textconv);

    const result = await workspace.gitDiff();
    const exposed = JSON.stringify(result);

    expect(result.status.exitCode).toBe(0);
    expect(result.diff.exitCode).toBe(0);
    expect(result.staged.exitCode).toBe(0);
    expect(exposed).toContain("public changed");
    expect(exposed).toContain("SAFE=changed-example");
    expect(exposed).not.toContain("changed-secret-canary");
    expect(exposed).not.toContain("changed-private-canary");
    expect(exposed).not.toContain("untracked-canary");
    expect(exposed).not.toContain(".npmrc");
    expect(exposed).not.toContain("private.pem");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(textconvMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("kills timed-out Git subprocesses before returning", async () => {
    const { root, workspace } = await workspaceFixture();
    const binaryDirectory = path.join(root, "fake-bin");
    const processDirectory = path.join(root, "fake-git-processes");
    await mkdir(binaryDirectory);
    await mkdir(processDirectory);
    await writeFile(
      path.join(binaryDirectory, "git"),
      "#!/usr/bin/env bun\n" +
        `await Bun.write(${JSON.stringify(`${processDirectory}/`)} + process.pid, \"started\\n\");\n` +
        "await Bun.sleep(60_000);\n" +
        `await Bun.write(${JSON.stringify(`${processDirectory}/late-`)} + process.pid, \"not killed\\n\");\n`,
      { encoding: "utf8", mode: 0o755 }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDirectory}${path.delimiter}${originalPath ?? ""}`;
    try {
      const startedAt = Date.now();
      const result = await workspace.gitDiff();
      const elapsedMs = Date.now() - startedAt;

      expect(result.status.timedOut).toBe(true);
      expect(result.diff.timedOut).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(14_000);
      expect(elapsedMs).toBeLessThan(20_000);

      const markers = await readdir(processDirectory);
      const pids = markers.filter((name) => /^\d+$/.test(name)).map(Number);
      expect(pids).toHaveLength(3);
      expect(markers.some((name) => name.startsWith("late-"))).toBe(false);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  }, 20_000);

  test("a denied interrupt approval never executes its side effect", async () => {
    const { root } = await workspaceFixture();
    const changes = [{ path: "denied.txt", expectedDigest: null, content: "must not exist\n" }];
    const proposal = createEditProposal({ changes });
    const model = createMockLanguageModel({
      provider: "mock-provider",
      modelId: "mock-model",
      streamEvents: [
        [
          {
            type: "tool-call",
            toolCall: {
              id: "denied-patch-1",
              name: "apply_patch",
              input: { proposalId: proposal.proposalId, changes }
            }
          },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "The write was denied." },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    });
    const store = createInMemoryAgentRunStore();
    const harness = await createHarness({
      provider: "openai",
      workspace: root,
      modelInstance: model,
      store
    });

    await expect(runHarness(harness, { runId: "denied-security-run", prompt: "Create denied.txt" }, {
      resolveApprovals: async (approvals) => approvals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: false,
        reason: "Security regression denial."
      }))
    })).rejects.toThrow("Security regression denial");

    await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow();
    const state = await store.load("denied-security-run");
    expect(state?.status).toBe("failed");
    expect(state?.approvalHistory).toContainEqual(expect.objectContaining({
      kind: "local-tool",
      approve: false
    }));
  });
});
