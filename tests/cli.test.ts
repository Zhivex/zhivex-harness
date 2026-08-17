import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLI_EXIT_CODES,
  CLI_JSON_SCHEMA_VERSION,
  CliUsageError,
  cliExitCodeForError,
  createDoctorReport,
  formatDoctorReport,
  parseCliArgs,
  providersDocument,
  runResultDocument,
  summarizeApproval
} from "../src/cli.js";
import { HARNESS_VERSION } from "../src/version.js";

const runCli = async (arguments_: string[]) => {
  const child = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../src/cli.ts"),
    ...arguments_
  ], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { stdout, stderr, exitCode };
};

describe("CLI parsing", () => {
  test("parses one-shot provider and workspace options", () => {
    expect(parseCliArgs([
      "run",
      "--provider",
      "qwen",
      "--model",
      "qwen3.8-max",
      "--workspace",
      "/tmp/repo",
      "--max-steps",
      "8",
      "--allow-check",
      "test:unit",
      "--allow-check",
      "format",
      "fix",
      "the tests"
    ])).toMatchObject({
      command: "run",
      provider: "qwen",
      model: "qwen3.8-max",
      workspace: "/tmp/repo",
      maxSteps: 8,
      allowedChecks: ["test:unit", "format"],
      prompt: "fix the tests"
    });
  });

  test("supports implicit run and resume decisions", () => {
    expect(parseCliArgs(["explain", "the repo"]).prompt).toBe("explain the repo");
    expect(parseCliArgs(["resume", "run-1", "--approve"])).toMatchObject({
      command: "resume",
      runId: "run-1",
      approve: true
    });
  });

  test("parses doctor diagnostics options", () => {
    expect(parseCliArgs([
      "doctor",
      "--provider",
      "meta",
      "--workspace",
      "/tmp/repo",
      "--state-dir",
      "/tmp/state",
      "--json"
    ])).toMatchObject({
      command: "doctor",
      provider: "meta",
      workspace: "/tmp/repo",
      stateDirectory: "/tmp/state",
      json: true
    });
  });

  test("parses durable run operations and budget limits", () => {
    expect(parseCliArgs([
      "runs",
      "list",
      "--status",
      "waiting_approval",
      "--limit",
      "25",
      "--store",
      "sqlite",
      "--tenant",
      "acme",
      "--json"
    ])).toMatchObject({
      command: "runs",
      runsCommand: "list",
      statuses: ["waiting_approval"],
      limit: 25,
      storeBackend: "sqlite",
      tenantId: "acme",
      json: true
    });
    expect(parseCliArgs([
      "run",
      "--idempotency-key",
      "request-42",
      "--max-tool-calls",
      "10",
      "--max-total-tokens",
      "50000",
      "inspect"
    ])).toMatchObject({
      idempotencyKey: "request-42",
      maxToolCalls: 10,
      maxTotalTokens: 50_000,
      prompt: "inspect"
    });
    expect(() => parseCliArgs(["runs", "inspect"])).toThrow("runId");
    expect(() => parseCliArgs(["runs", "cleanup"])).toThrow("--before");
  });

  test("rejects ambiguous or unknown options", () => {
    expect(() => parseCliArgs(["resume", "run-1", "--approve", "--deny"])).toThrow("combine");
    expect(() => parseCliArgs(["run", "--wat"])).toThrow("Unknown option");
    expect(() => parseCliArgs(["run", "--provider", "unknown"])).toThrow("Unknown provider");
    expect(() => parseCliArgs(["run", "--max-steps", "many"])).toThrow("--max-steps");
    expect(() => parseCliArgs(["run", "--allow-check", "../../escape"])).toThrow("--allow-check");
    expect(() => parseCliArgs([
      "run",
      ...Array.from({ length: 51 }, (_, index) => ["--allow-check", `check-${index}`]).flat()
    ])).toThrow("more than 50");
    expect(cliExitCodeForError(new CliUsageError("bad input"))).toBe(CLI_EXIT_CODES.usageError);
    expect(cliExitCodeForError(new Error("boom"))).toBe(CLI_EXIT_CODES.runtimeError);
  });
});

describe("approval review", () => {
  test("shows complete patch proposals while bounding unrelated approval arguments", () => {
    const argumentsText = JSON.stringify({ content: "x".repeat(2000) });
    const patchSummary = summarizeApproval({
      kind: "local-tool",
      name: "apply_patch",
      arguments: argumentsText
    } as never);
    const checkSummary = summarizeApproval({
      kind: "local-tool",
      name: "run_check",
      arguments: argumentsText
    } as never);

    expect(patchSummary).toContain(argumentsText);
    expect(checkSummary).toContain("…");
    expect(checkSummary).not.toContain(argumentsText);
  });
});

describe("versioned JSON contracts", () => {
  test("wraps providers without exposing credential or endpoint values", () => {
    const document = providersDocument({
      OPENAI_API_KEY: "secret-api-value",
      OPENAI_BASE_URL: "https://secret-host.invalid/v1"
    });

    expect(document).toMatchObject({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: "providers"
    });
    expect(JSON.stringify(document)).not.toContain("secret-api-value");
    expect(JSON.stringify(document)).not.toContain("secret-host");
  });

  test("versions final run results", () => {
    const document = runResultDocument({
      status: "completed",
      outputText: "done",
      steps: [],
      toolResults: [],
      usage: {},
      state: {
        schemaVersion: 1,
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-test",
        status: "completed",
        messages: [],
        steps: [],
        toolResults: [],
        currentStep: 0,
        maxSteps: 12,
        outputText: "done",
        pendingApprovals: []
      }
    } as never, {
      config: {
        stateDirectory: "/tmp/state",
        storeBackend: "sqlite",
        budget: {
          maxSteps: 12,
          maxToolCalls: 32,
          maxToolErrors: 4,
          maxInputTokens: 100_000,
          maxOutputTokens: 30_000,
          maxTotalTokens: 120_000,
          includeChildRuns: true
        }
      },
      workspace: { mutationAudit: () => [] }
    } as never);

    expect(document).toMatchObject({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: "run-result",
      runId: "run-1",
      status: "completed",
      stateDirectory: "/tmp/state",
      mutations: []
    });
  });
});

describe("CLI process contract", () => {
  test("uses stable success, usage, runtime, and doctor exit codes", async () => {
    const version = await runCli(["--version"]);
    expect(version).toMatchObject({ exitCode: CLI_EXIT_CODES.success, stdout: `${HARNESS_VERSION}\n` });

    const usage = await runCli(["run", "--max-steps", "invalid"]);
    expect(usage.exitCode).toBe(CLI_EXIT_CODES.usageError);

    const runtime = await runCli(["chat"]);
    expect(runtime.exitCode).toBe(CLI_EXIT_CODES.runtimeError);

    const workspace = path.resolve(import.meta.dir, "..");
    const doctor = await runCli([
      "doctor",
      "--workspace",
      workspace,
      "--state-dir",
      workspace,
      "--json"
    ]);
    expect(doctor.exitCode).toBe(CLI_EXIT_CODES.doctorFailed);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: "doctor",
      ok: false
    });
  });

  test("lists durable runs without provider credentials", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-runs-cli-"));
    try {
      const result = await runCli([
        "runs",
        "list",
        "--workspace",
        workspace,
        "--state-dir",
        path.join(workspace, ".zhivex-harness", "runs"),
        "--json"
      ]);
      expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: "run-list",
        backend: "sqlite",
        runs: []
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("doctor", () => {
  test("reports local readiness without network access or secret values", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-"));
    try {
      await writeFile(path.join(workspace, "package.json"), JSON.stringify({
        scripts: { test: "bun test", typecheck: "tsc --noEmit" }
      }));
      const report = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs")
      }, {
        bunVersion: "1.3.7",
        env: {
          OPENAI_API_KEY: "do-not-print-this-key",
          OPENAI_BASE_URL: "https://secret-host.invalid/v1"
        }
      });

      expect(report).toMatchObject({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        kind: "doctor",
        ok: true,
        harnessVersion: HARNESS_VERSION,
        configuration: {
          provider: "openai",
          stateDirectory: path.join(await realpath(workspace), ".zhivex-harness", "runs")
        }
      });
      expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
        "bun",
        "workspace",
        "git",
        "scripts",
        "state-directory",
        "provider:meta",
        "provider:qwen",
        "provider:openai"
      ]));
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("do-not-print-this-key");
      expect(serialized).not.toContain("secret-host");
      expect(formatDoctorReport(report)).toContain("Doctor completed without blocking problems.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fails old Bun, missing selected credentials, and unsafe state paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-"));
    try {
      const report = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, "src", "runs")
      }, { bunVersion: "1.2.0", env: {} });

      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.id === "bun")?.status).toBe("fail");
      expect(report.checks.find((check) => check.id === "provider:openai")?.status).toBe("fail");
      expect(report.checks.find((check) => check.id === "state-directory")).toMatchObject({
        status: "fail",
        details: { sensitiveSegment: "src" }
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects workspace-root and symlinked state directories", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-"));
    const stateTarget = await mkdtemp(path.join(os.tmpdir(), "zhivex-state-"));
    try {
      const rootReport = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: workspace
      }, { bunVersion: "1.3.7", env: { OPENAI_API_KEY: "present" } });
      expect(rootReport.checks.find((check) => check.id === "state-directory")?.status).toBe("fail");

      const stateLink = path.join(workspace, "state-link");
      await symlink(stateTarget, stateLink, "dir");
      await mkdir(path.join(stateTarget, "runs"));
      const linkReport = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(stateLink, "runs")
      }, { bunVersion: "1.3.7", env: { OPENAI_API_KEY: "present" } });
      expect(linkReport.checks.find((check) => check.id === "state-directory")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("symbolic link")
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(stateTarget, { recursive: true, force: true });
    }
  });
});
