import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdtemp, rm, readFile, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseCliArgs, CliUsageError } from "../src/cli/arguments.js";
import { readStdinTask, MAX_STDIN_TASK_BYTES } from "../src/cli/task-input.js";
import { cliRecoveryHint, cliExitCodeForError } from "../src/cli/errors.js";
import { createCliProfile, loadCliProfile, updateCliProfile, resolveCliProfilePath } from "../src/cli/cli-profiles.js";
import { HarnessConfigError, HarnessProviderError } from "../src/runtime/errors.js";

test("appended help bypasses runtime validation and preserves literal arguments after --", () => {
  for (const args of [
    ["run", "task", "--help"], ["run", "--provider", "invalid", "--help"],
    ["run", "--model", "--help"], ["run", "--max-steps", "invalid", "-h"],
    ["run", "--profile", "missing", "-", "--help"],
    ["run", "--unknown", "--help"],
  ]) expect(parseCliArgs(args)).toMatchObject({ command: "help", helpTopic: "run" });
  expect(parseCliArgs(["runs", "inspect", "some-id", "--help"])).toMatchObject({ helpTopic: "runs:inspect" });
  expect(parseCliArgs(["run", "--", "--help"])).toMatchObject({ command: "run", prompt: "--help" });
  expect(() => parseCliArgs(["runs", "unknown", "--help"])).toThrow("Unknown help topic");
});

test("equals values retain option validation and stdin is a standalone task", () => {
  expect(parseCliArgs(["run", "--model=custom=model", "task"])).toMatchObject({ model: "custom=model" });
  expect(() => parseCliArgs(["run", "--model=", "task"])).toThrow("Missing value");
  expect(() => parseCliArgs(["run", "--yes=false", "task"])).toThrow("Unknown option");
  expect(parseCliArgs(["run", "--", "--model=x"])).toMatchObject({ prompt: "--model=x" });
  expect(parseCliArgs(["review", "-"])).toMatchObject({ command: "review", prompt: "-" });
  expect(() => parseCliArgs(["run", "-", "extra"])).toThrow("Use - alone");
  expect(parseCliArgs(["init", "--update"])).toMatchObject({ updateProfile: true });
  expect(() => parseCliArgs(["run", "--update", "task"])).toThrow("not supported");
});

test("stdin preserves multiline Unicode and rejects empty, binary, oversized and TTY input", async () => {
  const content = "  revisá este diff\n+ línea nueva\n";
  const buffer = Buffer.from(content);
  expect(await readStdinTask(Readable.from([...buffer].map(byte => Buffer.from([byte]))))).toBe(content);
  await expect(readStdinTask(Readable.from([" \n"])) ).rejects.toThrow("empty");
  await expect(readStdinTask(Readable.from([Buffer.from([0xff])]))).rejects.toThrow("UTF-8");
  await expect(readStdinTask(Readable.from([Buffer.alloc(MAX_STDIN_TASK_BYTES + 1)]))).rejects.toThrow("1 MiB");
  await expect(readStdinTask(Object.assign(Readable.from([]), { isTTY: true }))).rejects.toThrow("Pipe a task");
});

test("profile update preserves the original on invalid input and rejects linked destinations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-dx-profile-"));
  const context = { env: { ZHIVEX_HARNESS_CONFIG_DIR: root } };
  try {
    const original = { provider: "openai" as const, model: "original" };
    await createCliProfile("daily", original, context);
    const before = await readFile(resolveCliProfilePath("daily", context), "utf8");
    await expect(updateCliProfile("daily", { ...original, model: "" }, context)).rejects.toThrow("invalid");
    expect(await readFile(resolveCliProfilePath("daily", context), "utf8")).toBe(before);
    await updateCliProfile("daily", { provider: "qwen", model: "replacement" }, context);
    expect(await loadCliProfile("daily", context)).toMatchObject({ provider: "qwen", model: "replacement" });
    expect(await readdir(path.join(root, "profiles"))).toEqual(["daily.json"]);
    await symlink(resolveCliProfilePath("daily", context), resolveCliProfilePath("linked", context));
    await expect(updateCliProfile("linked", original, context)).rejects.toThrow("non-linked");
    expect(await loadCliProfile("daily", context)).toMatchObject({ model: "replacement" });
    for (const directory of [path.join(root, "absent"), root]) {
      try {
        await loadCliProfile("missing", { env: { ZHIVEX_HARNESS_CONFIG_DIR: directory } });
        throw new Error("Expected a missing profile error");
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessConfigError);
        expect((error as Error).message).toContain("Create it with zhx init");
        expect(cliExitCodeForError(error)).toBe(2);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("usage recovery is actionable and independent from provider or OCI diagnostics", () => {
  const hint = cliRecoveryHint(new CliUsageError("Unknown option"), ["run", "--bad"]);
  expect(hint).toContain("zhx run --help");
  expect(hint).not.toContain("credentials");
  expect(cliRecoveryHint(new HarnessProviderError("unavailable"), [])).toContain("/credentials");
});

test("CLI pipelines preserve task text, suspend edits for approval, and bypass stdin for help", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-dx-process-"));
  const requests = path.join(root, "requests.jsonl");
  const invoke = async (args: string[], input = "", extraEnv: Record<string, string> = {}) => {
    const child = Bun.spawn([
      process.execPath, "--preload", path.resolve(import.meta.dir, "fixtures/console-fetch.mjs"),
      path.resolve(import.meta.dir, "../src/cli.ts"), ...args
    ], {
      cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, NO_COLOR: "1",
        ZHIVEX_HARNESS_CONFIG_DIR: path.join(root, "config"),
        OPENAI_API_KEY: "offline-fixture", CONSOLE_FIXTURE_REQUESTS: requests, ...extraEnv },
      stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 10_000
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
    ]);
    return { stdout, stderr, code };
  };
  try {
    const help = await invoke(["run", "--profile", "missing", "-", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Examples:");
    expect(await Bun.file(requests).exists()).toBe(false);
    const empty = await invoke(["run", "-"]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("Stdin task is empty");
    const task = "Explain this exact Unicode task:\n  línea nueva\n";
    const run = await invoke(["run", "--model", "gpt-5.6-luna", "--jsonl", "-"], task);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Fixture done");
    expect(await readFile(requests, "utf8")).toContain(JSON.stringify(task).slice(1, -1));
    const edit = await invoke(["run", "--model", "gpt-5.6-luna", "--json", "-"], "EDIT_FIXTURE");
    expect(edit.code).toBe(0);
    expect(JSON.parse(edit.stdout).status).toBe("waiting_approval");
    expect(await Bun.file(path.join(root, "result.txt")).exists()).toBe(false);

    expect((await invoke(["init", "--provider", "openai", "--model", "original", "--json"])).code).toBe(0);
    const updated = await invoke(["init", "--update", "--model", "replacement", "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout).profile).toMatchObject({ provider: "openai", model: "replacement" });
    const preserved = await invoke(["init", "--update", "--json"], "", { ZHIVEX_HARNESS_MODEL: "env-model" });
    expect(JSON.parse(preserved.stdout).profile.model).toBe("replacement");
    const switched = await invoke(["init", "--update", "--provider", "qwen", "--json"], "", { ZHIVEX_HARNESS_MODEL: "env-model" });
    expect(JSON.parse(switched.stdout).profile.provider).toBe("qwen");
    expect(JSON.parse(switched.stdout).profile.model).not.toBe("env-model");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
