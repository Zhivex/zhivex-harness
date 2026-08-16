import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("security regressions", () => {
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
      expect(pids).toHaveLength(2);
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
    const model = createMockLanguageModel({
      provider: "mock-provider",
      modelId: "mock-model",
      streamEvents: [
        [
          {
            type: "tool-call",
            toolCall: {
              id: "denied-write-1",
              name: "write_file",
              input: { path: "denied.txt", content: "must not exist\n", overwrite: false }
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
    const harness = await createHarness({
      provider: "openai",
      workspace: root,
      modelInstance: model,
      store: createInMemoryAgentRunStore()
    });

    const result = await runHarness(harness, { prompt: "Create denied.txt" }, {
      resolveApprovals: async (approvals) => approvals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: false,
        reason: "Security regression denial."
      }))
    });

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("The write was denied.");
    await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow();
    expect(result.state.approvalHistory).toContainEqual(expect.objectContaining({
      kind: "local-tool",
      approve: false
    }));
  });
});
