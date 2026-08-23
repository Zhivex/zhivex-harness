import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLI_EXIT_CODES,
  CLI_JSON_SCHEMA_VERSION,
  CliUsageError,
  cliExitCodeForError,
  createHarnessResumeMetadata,
  createDoctorReport,
  formatDoctorReport,
  parseCliArgs,
  providersDocument,
  readHarnessResumeConfig,
  readHarnessResumeRoutes,
  resumeCommand,
  runResultDocument,
  summarizeApproval,
  withTemporaryHarnessProfiles
} from "../src/cli.js";
import { resolveHarnessConfig, type HarnessSubagentProfile } from "../src/config.js";
import { HARNESS_VERSION } from "../src/version.js";

const runCli = async (arguments_: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../src/cli.ts"),
    ...arguments_
  ], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env },
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
    expect(parseCliArgs(["explain", "the repo"])).toMatchObject({
      prompt: "explain the repo",
      implicitCommand: true
    });
    expect(parseCliArgs(["resume", "run-1", "--approve"])).toMatchObject({
      command: "resume",
      runId: "run-1",
      approve: true
    });
  });

  test("parses Gemini, model routes, JSONL, and durable session commands", () => {
    expect(parseCliArgs([
      "run",
      "--provider",
      "gemini",
      "--route",
      "reviewer=openai:gpt-5.6-terra",
      "--jsonl",
      "review",
      "this"
    ])).toMatchObject({
      provider: "gemini",
      routes: ["reviewer=openai:gpt-5.6-terra"],
      jsonl: true,
      prompt: "review this"
    });
    expect(parseCliArgs(["chat", "--continue"])).toMatchObject({ command: "chat", continueSession: true });
    expect(parseCliArgs(["sessions", "rename", "ses_1", "new", "name"])).toMatchObject({
      command: "sessions",
      sessionsCommand: "rename",
      sessionId: "ses_1",
      sessionTitle: "new name"
    });
    expect(() => parseCliArgs(["run", "--json", "--jsonl", "task"])).toThrow("combine");
    expect(() => parseCliArgs(["chat", "--jsonl"])).toThrow("run and resume");
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

  test("parses governed MCP, capability, and review-group options", () => {
    expect(parseCliArgs([
      "review",
      "--mcp-config",
      "harness.mcp.json",
      "--context-config",
      ".zhivex/custom.json",
      "--no-project-context",
      "--require-capability",
      "tools",
      "--subagent",
      "explorer",
      "--reviewer",
      "reviewer",
      "--subagent-max-total-tokens",
      "12000",
      "review",
      "durability"
    ])).toMatchObject({
      command: "review",
      mcpConfigPath: "harness.mcp.json",
      contextConfigPath: ".zhivex/custom.json",
      projectContext: false,
      requiredCapabilities: ["tools"],
      subagentProfiles: ["explorer"],
      reviewers: ["reviewer"],
      subagentMaxTotalTokens: 12_000,
      prompt: "review durability"
    });
    expect(() => parseCliArgs(["run", "--require-capability", "telepathy"])).toThrow("require-capability");
    expect(() => parseCliArgs(["review", "--reviewer", "implementer", "task"])).toThrow("--reviewer");
  });

  test("parses enforced OCI execution limits and command allowlists", () => {
    expect(parseCliArgs([
      "run",
      "--execution",
      "oci",
      "--oci-runtime",
      "podman",
      "--oci-image",
      "example/harness@sha256:fixture",
      "--oci-allow-command",
      "node",
      "--oci-allow-command",
      "npm",
      "--oci-allow-command",
      "git",
      "--oci-shell",
      "ask",
      "--oci-max-memory-mb",
      "512",
      "--oci-max-pids",
      "64",
      "isolated",
      "task"
    ])).toMatchObject({
      executionBackend: "oci",
      ociRuntime: "podman",
      ociImage: "example/harness@sha256:fixture",
      ociAllowedCommands: ["node", "npm", "git"],
      ociShellMode: "ask",
      ociMaxMemoryMb: 512,
      ociMaxPids: 64,
      prompt: "isolated task"
    });
    expect(() => parseCliArgs(["run", "--oci-allow-command", "../sh", "task"]))
      .toThrow("bare executable");
    expect(() => parseCliArgs(["run", "--oci-shell", "allow", "task"]))
      .toThrow("deny or ask");
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

  test("parses offline change-envelope creation and verification", () => {
    expect(parseCliArgs([
      "changes",
      "create",
      "input.json",
      "--patch",
      "change.patch"
    ])).toMatchObject({
      command: "changes",
      changesCommand: "create",
      artifactPath: "input.json",
      patchPath: "change.patch"
    });
    expect(parseCliArgs([
      "changes",
      "verify",
      "envelope.json",
      "--patch",
      "change.patch",
      "--preconditions",
      "expected.json",
      "--now",
      "2026-08-20T12:00:00.000Z"
    ])).toMatchObject({
      command: "changes",
      changesCommand: "verify",
      preconditionsPath: "expected.json",
      verificationTime: "2026-08-20T12:00:00.000Z"
    });
    expect(() => parseCliArgs(["changes", "verify", "envelope.json"]))
      .toThrow("requires --patch");
  });
});

describe("change-envelope CLI", () => {
  test("binds exact patch bytes and fails verification for a different artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-change-envelope-cli-"));
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    try {
      const inputPath = path.join(root, "input.json");
      const patchPath = path.join(root, "change.patch");
      const changedPatchPath = path.join(root, "changed.patch");
      const envelopePath = path.join(root, "envelope.json");
      await writeFile(patchPath, "diff --git a/a.txt b/a.txt\n+governed\n", "utf8");
      await writeFile(changedPatchPath, "diff --git a/a.txt b/a.txt\n+tampered\n", "utf8");
      await writeFile(inputPath, `${JSON.stringify({
        createdAt: "2026-08-20T12:00:00.000Z",
        expiresAt: "2026-08-21T12:00:00.000Z",
        base: { workspaceDigest: digest("1"), treeDigest: digest("2") },
        patch: { patchId: "candidate-42" },
        fingerprints: {
          harness: digest("3"),
          policy: digest("4"),
          environment: digest("5")
        },
        checks: [{
          checkId: "tests",
          status: "passed",
          redacted: true,
          startedAt: "2026-08-20T11:59:00.000Z",
          completedAt: "2026-08-20T11:59:01.000Z",
          durationMs: 1_000,
          exitCode: 0
        }]
      }, null, 2)}\n`, "utf8");

      const created = await runCli(["changes", "create", inputPath, "--patch", patchPath]);
      expect(created.exitCode).toBe(CLI_EXIT_CODES.success);
      const envelope = JSON.parse(created.stdout) as { envelopeId: string; patch: { patchDigest: string } };
      expect(envelope.envelopeId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(envelope.patch.patchDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      await writeFile(envelopePath, created.stdout, "utf8");

      const verified = await runCli([
        "changes",
        "verify",
        envelopePath,
        "--patch",
        patchPath,
        "--now",
        "2026-08-20T12:30:00.000Z"
      ]);
      expect(verified.exitCode).toBe(CLI_EXIT_CODES.success);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: "change-envelope-verification",
        valid: true,
        verificationScope: "integrity-expiration-and-preconditions-only",
        approvals: { authenticity: "not-verified" }
      });

      const rejected = await runCli([
        "changes",
        "verify",
        envelopePath,
        "--patch",
        changedPatchPath,
        "--now",
        "2026-08-20T12:30:00.000Z"
      ]);
      expect(rejected.exitCode).toBe(CLI_EXIT_CODES.runtimeError);
      expect(JSON.parse(rejected.stdout).issues).toContainEqual(expect.objectContaining({
        code: "precondition-mismatch",
        path: ["patch", "patchDigest"]
      }));

      const linkedPatchPath = path.join(root, "linked.patch");
      await symlink(patchPath, linkedPatchPath);
      const linked = await runCli(["changes", "create", inputPath, "--patch", linkedPatchPath]);
      expect(linked.exitCode).toBe(CLI_EXIT_CODES.usageError);
      expect(linked.stderr).toContain("regular non-symlink file");

      for (const [label, arguments_] of [
        ["input", ["changes", "create", path.join(root, "missing-input.json"), "--patch", patchPath]],
        ["patch", ["changes", "create", inputPath, "--patch", path.join(root, "missing.patch")]],
        ["preconditions", [
          "changes",
          "verify",
          envelopePath,
          "--patch",
          patchPath,
          "--preconditions",
          path.join(root, "missing-preconditions.json")
        ]]
      ] as const) {
        const missing = await runCli([...arguments_]);
        expect(missing.exitCode, label).toBe(CLI_EXIT_CODES.usageError);
        expect(missing.stderr).toContain("Change artifact cannot be read (ENOENT)");
      }

      if (process.getuid?.() !== 0) {
        const unreadablePath = path.join(root, "unreadable.patch");
        await writeFile(unreadablePath, "unreadable\n", "utf8");
        await chmod(unreadablePath, 0o000);
        try {
          const unreadable = await runCli(["changes", "create", inputPath, "--patch", unreadablePath]);
          expect(unreadable.exitCode).toBe(CLI_EXIT_CODES.usageError);
          expect(unreadable.stderr).toContain("Change artifact cannot be read (EACCES)");
        } finally {
          await chmod(unreadablePath, 0o600);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("temporary chat profiles", () => {
  test("restores the configured profile set after success and failure", async () => {
    const transitions: string[][] = [];
    const configure = async (profiles: readonly HarnessSubagentProfile[]) => {
      transitions.push([...profiles]);
    };

    await expect(withTemporaryHarnessProfiles(
      ["explorer", "reviewer"],
      configure,
      async () => "reviewed"
    )).resolves.toBe("reviewed");
    expect(transitions).toEqual([["explorer", "reviewer"], []]);

    transitions.length = 0;
    await expect(withTemporaryHarnessProfiles(
      ["explorer", "reviewer"],
      configure,
      async () => { throw new Error("review failed"); }
    )).rejects.toThrow("review failed");
    expect(transitions).toEqual([["explorer", "reviewer"], []]);
  });
});

describe("approval review", () => {
  test("shows complete governed payloads while bounding unknown approval arguments", () => {
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
    const unknownSummary = summarizeApproval({
      kind: "provider",
      name: "unknown_remote_tool",
      arguments: argumentsText
    } as never);

    expect(patchSummary).toContain("x".repeat(2000));
    expect(checkSummary).toContain("x".repeat(2000));
    expect(unknownSummary).toContain("characters omitted");
    expect(unknownSummary).not.toContain("x".repeat(2000));
  });

  test("persists the complete OCI policy for a locator-only resume command", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-resume-oci-"));
    try {
      const config = resolveHarnessConfig({
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs"),
        storeBackend: "file",
        tenantId: "tenant-a",
        userId: "user-a",
        namespace: "namespace-a",
        executionBackend: "oci",
        ociRuntime: "podman",
        ociImage: "example/harness@sha256:fixture",
        ociAllowedCommands: ["npm", "git"],
        ociShellMode: "ask",
        ociMaxProcessRuntimeMs: 42_000,
        ociMaxProcessOutputBytes: 12_345,
        ociMaxMemoryMb: 512,
        ociMaxPids: 64,
        ociMaxCpus: 1,
        ociMaxWorkspaceBytes: 16 * 1024 * 1024,
        ociMaxFileWriteBytes: 512 * 1024,
        ociTmpfsMb: 32
      });
      const metadata = createHarnessResumeMetadata(config);
      const restoredInput = readHarnessResumeConfig({ metadata });
      expect(restoredInput).toBeDefined();
      const restored = resolveHarnessConfig(restoredInput!);
      expect(restored.execution).toEqual(config.execution);
      expect(restored.workspace).toBe(config.workspace);
      expect(restored.stateDirectory).toBe(config.stateDirectory);
      expect(restored.storeBackend).toBe(config.storeBackend);
      expect(restored.scope).toEqual(config.scope);

      const command = resumeCommand("run-oci", config);
      expect(command).toContain("resume 'run-oci' --approve");
      expect(command).toContain(`--workspace '${config.workspace}'`);
      expect(command).toContain(`--state-dir '${config.stateDirectory}'`);
      expect(command).toContain("--store file");
      expect(command).toContain("--tenant 'tenant-a'");
      expect(command).toContain("--user 'user-a'");
      expect(command).toContain("--namespace 'namespace-a'");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists safe multi-provider routes for approval resume", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-resume-routes-"));
    try {
      const config = resolveHarnessConfig({ workspace });
      const metadata = createHarnessResumeMetadata(config, new Map([["reviewer", {
        profile: "reviewer",
        provider: "gemini",
        model: "gemini-3.6-flash"
      }]]));
      const routes = readHarnessResumeRoutes({ metadata });
      expect(routes.get("reviewer")).toEqual({
        profile: "reviewer",
        provider: "gemini",
        model: "gemini-3.6-flash"
      });
      expect(JSON.stringify(metadata)).not.toContain("API_KEY");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
        orchestration: {
          profiles: ["explorer", "reviewer"],
          childBudget: {
            maxSteps: 8,
            maxToolCalls: 16,
            maxToolErrors: 3,
            maxInputTokens: 30_000,
            maxOutputTokens: 8_000,
            maxTotalTokens: 36_000,
            includeChildRuns: false
          }
        },
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
      capabilities: { provider: "openai", model: "gpt-test", capabilities: {} },
      mcpConfiguration: { schemaVersion: 1, servers: [] },
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

    const invalidConfig = await runCli(["doctor", "--execution", "host", "--json"]);
    expect(invalidConfig.exitCode).toBe(CLI_EXIT_CODES.usageError);
    expect(invalidConfig.stderr).toContain("executionBackend");

    const invalidEnvironmentProvider = await runCli(["doctor", "--json"], {
      ZHIVEX_HARNESS_PROVIDER: "deepseek"
    });
    expect(invalidEnvironmentProvider.exitCode).toBe(CLI_EXIT_CODES.usageError);
    expect(invalidEnvironmentProvider.stderr).toContain("Unknown provider");

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

  test("rejects routed models when the cost budget comes from the environment", async () => {
    const result = await runCli([
      "run",
      "--route",
      "reviewer=gemini",
      "review the change"
    ], {
      ZHIVEX_HARNESS_MAX_COST_USD: "1",
      ZHIVEX_HARNESS_INPUT_COST_PER_MILLION: "2"
    });

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usageError);
    expect(result.stderr).toContain("Cost budgets cannot be combined with model routes");
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
        packageManager: "npm@11.5.1",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" }
      }));
      const report = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs")
      }, {
        nodeVersion: "22.13.0",
        env: {
          OPENAI_API_KEY: "do-not-print-this-key",
          OPENAI_BASE_URL: "https://secret-host.invalid/v1",
          ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS: "3",
          ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS: "1"
        }
      });

      expect(report).toMatchObject({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        kind: "doctor",
        ok: true,
        harnessVersion: HARNESS_VERSION,
        configuration: {
          provider: "openai",
          stateDirectory: path.join(await realpath(workspace), ".zhivex-harness", "runs"),
          orchestration: {
            childBudget: { maxSteps: 3 },
            maxParallelReviews: 1
          }
        }
      });
      expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
        "node",
        "workspace",
        "git",
        "scripts",
        "state-directory",
        "project-context",
        "execution-environment",
        "provider:meta",
        "provider:qwen",
        "provider:openai",
        "provider:gemini"
      ]));
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("do-not-print-this-key");
      expect(serialized).not.toContain("secret-host");
      expect(formatDoctorReport(report)).toContain("Doctor completed without blocking problems.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fails when configured project context cannot be loaded", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-context-"));
    try {
      await mkdir(path.join(workspace, ".zhivex"), { recursive: true });
      await writeFile(path.join(workspace, ".zhivex", "harness.json"), "{not-json\n");
      const invalid = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs")
      }, { nodeVersion: "22.13.0", env: { OPENAI_API_KEY: "present" } });
      expect(invalid.ok).toBe(false);
      expect(invalid.checks.find((check) => check.id === "project-context")).toMatchObject({
        status: "fail",
        message: "Project context cannot be loaded.",
        details: { error: expect.stringContaining("not valid JSON") }
      });

      const missing = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs"),
        contextConfigPath: ".zhivex/missing.json"
      }, { nodeVersion: "22.13.0", env: { OPENAI_API_KEY: "present" } });
      expect(missing.ok).toBe(false);
      expect(missing.checks.find((check) => check.id === "project-context")).toMatchObject({
        status: "fail",
        details: { error: expect.stringContaining("Required harness context manifest was not found") }
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("checks the immutable OCI image when enforced execution is selected", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-oci-"));
    try {
      await writeFile(path.join(workspace, "package.json"), JSON.stringify({
        packageManager: "npm@11.5.1",
        scripts: { test: "node --test" }
      }));
      const runtime = {
        inspectImage: async (imageReference: string) => ({
          runtime: "docker" as const,
          runtimeVersion: "fixture-1",
          imageReference,
          imageId: `sha256:${"a".repeat(64)}`,
          imageDigest: `sha256:${"a".repeat(64)}`
        }),
        run: async () => { throw new Error("not used"); },
        removeRunContainers: async () => 0,
        cleanupOrphans: async () => 0
      };
      const report = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, ".zhivex-harness", "runs"),
        executionBackend: "oci"
      }, {
        nodeVersion: "22.13.0",
        env: { OPENAI_API_KEY: "present" },
        ociRuntimeAdapter: runtime
      });
      expect(report.configuration.execution).toMatchObject({ backend: "oci", runtime: "docker" });
      expect(report.checks.find((check) => check.id === "execution-environment")).toMatchObject({
        status: "pass",
        details: { network: "deny", shellAvailable: true }
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fails old Node, missing selected credentials, and unsafe state paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-doctor-"));
    try {
      const report = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(workspace, "src", "runs")
      }, { nodeVersion: "22.12.0", env: {} });

      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.id === "node")?.status).toBe("fail");
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
      }, { nodeVersion: "22.13.0", env: { OPENAI_API_KEY: "present" } });
      expect(rootReport.checks.find((check) => check.id === "state-directory")?.status).toBe("fail");

      const stateLink = path.join(workspace, "state-link");
      await symlink(stateTarget, stateLink, "dir");
      await mkdir(path.join(stateTarget, "runs"));
      const linkReport = await createDoctorReport({
        provider: "openai",
        workspace,
        stateDirectory: path.join(stateLink, "runs")
      }, { nodeVersion: "22.13.0", env: { OPENAI_API_KEY: "present" } });
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
