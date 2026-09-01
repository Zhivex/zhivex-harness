import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertNoForbiddenDiagnosticContent,
  diagnosticFingerprint,
  parseTimeToSafeFixDiagnostic,
  releaseDiagnosticBindingFromEnv,
  restoreSanitizedOperationalError,
  sanitizeOperationalError,
  summarizeReleaseGates,
  writeLiveGateDiagnostic
} from "../scripts/release-diagnostics.js";
import { HarnessExecutionError, HarnessProviderError } from "../src/errors.js";

const artifactSha512 = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const workflowBinding = {
  releaseTag: "v1.0.0-rc.8",
  sourceCommit: "a".repeat(40),
  artifactSha512,
  workflowRunUrl: "https://github.com/Zhivex/zhivex-harness/actions/runs/123",
  workflowRunAttempt: 3
};
const binding = (provider: string) => ({
  ...workflowBinding,
  provider,
  model: provider === "meta" ? "muse-spark-1.2" : provider === "qwen" ? "qwen3.8-max" : "gpt-5.6-luna",
  driverCommit: "b".repeat(40),
  ociImageDigest: `sha256:${"c".repeat(64)}`
});

const diagnostic = (status: "passed" | "failed", provider = "meta") => ({
  schemaVersion: 2,
  kind: "time-to-safe-fix-diagnostics",
  status,
  generatedAt: "2026-08-25T23:07:35Z",
  binding: binding(provider),
  dataset: { name: "representative", revision: "v1", tasks: 1 },
  matrix: {
    profiles: ["governed"],
    carriers: ["rule_file"],
    repetitions: 1,
    plannedRuns: 1,
    completedRuns: 1
  },
  summary: status === "passed"
    ? { safeResolvedRuns: 1, failedRuns: 0 }
    : { safeResolvedRuns: 0, failedRuns: 1 },
  failedCases: status === "passed" ? [] : [{
    caseId: "case-1",
    caseFingerprint: diagnosticFingerprint({ caseId: "case-1", code: "PROVIDER_UNAVAILABLE" }),
    taskId: "task-1",
    profile: "governed",
    variant: "attacked",
    carrier: "rule_file",
    goal: "TEST_DELETE",
    repetition: 1,
    order: 0,
    utilityPass: false,
    attackCompleted: false,
    unauthorizedEffects: 0,
    environmentFailure: true,
    failure: {
      stage: "model",
      origin: "agent_run",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      harnessError: { code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: true }
    },
    durationMs: 42
  }]
});

describe("release diagnostics", () => {
  test("binds release diagnostics only when every immutable identity is present", () => {
    const binding = releaseDiagnosticBindingFromEnv({
      RELEASE_TAG: "v1.0.0-rc.8",
      SOURCE_COMMIT: "a".repeat(40),
      ARTIFACT_SHA512: artifactSha512,
      WORKFLOW_RUN_URL: "https://github.com/Zhivex/zhivex-harness/actions/runs/123",
      WORKFLOW_RUN_ATTEMPT: "3",
      ZHIVEX_SAFE_FIX_PROVIDER: "openai",
      ZHIVEX_SAFE_FIX_MODEL: "gpt-5.6-luna",
      DRIVER_COMMIT: "b".repeat(40),
      OCI_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`
    });
    expect(binding).toMatchObject({
      releaseTag: "v1.0.0-rc.8",
      workflowRunAttempt: 3,
      provider: "openai",
      model: "gpt-5.6-luna"
    });
    expect(() => releaseDiagnosticBindingFromEnv({ RELEASE_TAG: "v1.0.0-rc.8" }))
      .toThrow("binding is incomplete");
    expect(() => releaseDiagnosticBindingFromEnv({
      RELEASE_TAG: "v1.0.0-rc.8",
      SOURCE_COMMIT: "a".repeat(40),
      ARTIFACT_SHA512: "sha512-A",
      WORKFLOW_RUN_URL: "https://github.com/Zhivex/zhivex-harness/actions/runs/123",
      WORKFLOW_RUN_ATTEMPT: "3",
      ZHIVEX_SAFE_FIX_PROVIDER: "openai",
      ZHIVEX_SAFE_FIX_MODEL: "gpt-5.6-luna",
      DRIVER_COMMIT: "b".repeat(40),
      OCI_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`
    })).toThrow("canonical base64 SHA-512");
  });

  test("rejects forbidden raw diagnostic fields at any depth", () => {
    expect(() => assertNoForbiddenDiagnosticContent({
      safe: true,
      nested: { responseBody: { output: "provider payload" } }
    })).toThrow("Forbidden diagnostic field responseBody");
    for (const key of ["messages", "payload", "credentials", "headers", "apiKey", "request_id"]) {
      expect(() => assertNoForbiddenDiagnosticContent({ nested: { [key]: "raw" } })).toThrow(
        `Forbidden diagnostic field ${key}`
      );
    }
    expect(() => assertNoForbiddenDiagnosticContent(diagnostic("failed", "meta"))).not.toThrow();
  });

  test("rejects inconsistent diagnostic status and counts", () => {
    const inconsistent = {
      ...diagnostic("failed", "meta"),
      status: "passed",
      summary: { safeResolvedRuns: 0, failedRuns: 1 }
    };
    expect(() => parseTimeToSafeFixDiagnostic(inconsistent)).toThrow(
      "Passed diagnostics must be complete and failure-free"
    );
  });

  test("preserves a typed provider cause through a generic execution wrapper", () => {
    const error = new HarnessExecutionError("outer raw output", {
      cause: new HarnessProviderError("inner provider payload", { retryable: true })
    });
    const diagnosticError = sanitizeOperationalError(error);
    expect(diagnosticError).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      category: "provider",
      retryable: true
    });
    expect(JSON.stringify(diagnosticError)).not.toContain("raw output");
    expect(JSON.stringify(diagnosticError)).not.toContain("provider payload");

    const restored = restoreSanitizedOperationalError(diagnosticError);
    expect(sanitizeOperationalError(restored)).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      category: "provider",
      retryable: true
    });
  });

  test("writes a bounded Actions summary and fails closed on any provider", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-release-summary-"));
    const summaryPath = path.join(directory, "summary.md");
    try {
      await writeFile(path.join(directory, "meta.json"), `${JSON.stringify(diagnostic("passed", "meta"))}\n`);
      await writeFile(path.join(directory, "qwen.json"), `${JSON.stringify(diagnostic("failed", "qwen"))}\n`);
      const result = await summarizeReleaseGates({
        title: "Representative repository certification",
        diagnosticsDirectory: directory,
        summaryPath,
        gates: [
          { name: "meta", outcome: "success" },
          { name: "qwen", outcome: "failure" },
          { name: "openai", outcome: "skipped" }
        ]
      });
      expect(result.ok).toBe(false);
      expect(result.rows[0]).toEqual({ gate: "meta", outcome: "success", detail: "1/1 passed", failed: false });
      expect(result.rows[1]).toMatchObject({ gate: "qwen", outcome: "failure", failed: true });
      expect(result.rows[1]?.detail).toContain("PROVIDER_UNAVAILABLE [category=provider, retryable=true]");
      expect(result.rows[1]?.detail).toContain("fingerprints: sha256:");
      expect(result.rows[2]).toEqual({
        gate: "openai",
        outcome: "skipped",
        detail: "diagnostic unavailable",
        failed: true
      });
      const summary = await readFile(summaryPath, "utf8");
      expect(summary).toContain("| qwen | failure | 1 failed: PROVIDER_UNAVAILABLE [category=provider, retryable=true]");
      expect(summary).not.toContain("provider payload");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects unknown fields, missing bindings, and cross-provider identity drift", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-release-identity-"));
    try {
      await writeFile(path.join(directory, "meta.json"), `${JSON.stringify({
        ...diagnostic("passed", "meta"),
        payload: { apiKey: "raw-secret" }
      })}\n`);
      await writeFile(path.join(directory, "qwen.json"), `${JSON.stringify({
        ...diagnostic("passed", "qwen"),
        binding: { ...binding("qwen"), sourceCommit: "d".repeat(40) }
      })}\n`);
      const openai = diagnostic("passed", "openai");
      delete (openai as { binding?: unknown }).binding;
      await writeFile(path.join(directory, "openai.json"), `${JSON.stringify(openai)}\n`);

      const result = await summarizeReleaseGates({
        title: "Identity check",
        diagnosticsDirectory: directory,
        gates: [
          { name: "meta", outcome: "success" },
          { name: "qwen", outcome: "success" },
          { name: "openai", outcome: "success" }
        ]
      });
      expect(result.ok).toBe(false);
      expect(result.rows.map((row) => row.detail)).toEqual([
        "diagnostic unavailable",
        "1/1 passed",
        "diagnostic unavailable"
      ]);

      await writeFile(path.join(directory, "meta.json"), `${JSON.stringify(diagnostic("passed", "meta"))}\n`);
      await writeFile(path.join(directory, "openai.json"), `${JSON.stringify(diagnostic("passed", "openai"))}\n`);
      const drift = await summarizeReleaseGates({
        title: "Cross-binding check",
        diagnosticsDirectory: directory,
        gates: [
          { name: "meta", outcome: "success" },
          { name: "qwen", outcome: "success" },
          { name: "openai", outcome: "success" }
        ]
      });
      expect(drift.ok).toBe(false);
      expect(drift.rows.every((row) => row.detail === "diagnostic unavailable")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("writes strict bound diagnostics for every live gate", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-live-diagnostics-"));
    try {
      const out = path.join(directory, "oci.json");
      await writeLiveGateDiagnostic({
        out,
        binding: workflowBinding,
        gate: "oci",
        status: "failed",
        outcomes: [{
          status: "failed",
          error: sanitizeOperationalError(Object.assign(new Error("raw docker output"), { status: 503 }))
        }]
      });
      const result = await summarizeReleaseGates({
        title: "Live gates",
        diagnosticsDirectory: directory,
        expectedBinding: workflowBinding,
        gates: [{ name: "oci", outcome: "failure" }]
      });
      expect(result.ok).toBe(false);
      expect(result.rows[0]?.detail).toContain("PROVIDER_UNAVAILABLE [category=provider, retryable=true]");
      const persisted = await readFile(out, "utf8");
      expect(persisted).not.toContain("raw docker output");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("suppresses raw child output and preserves every provider outcome", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-gate-wrapper-"));
    const out = path.join(directory, "base.json");
    const qwenError = sanitizeOperationalError(new HarnessProviderError("raw qwen payload", {
      retryable: true
    }));
    const childPayload = JSON.stringify({
      ok: false,
      runId: "raw-run-id",
      messages: ["raw model-authored content"],
      providers: [
        { ok: true, provider: "meta", model: "muse-spark-1.2" },
        { ok: false, provider: "qwen", model: "qwen3.8-max", error: qwenError },
        { ok: true, provider: "openai", model: "gpt-5.6-luna" }
      ]
    });
    try {
      const child = Bun.spawn([
        process.execPath,
        path.join(import.meta.dir, "..", "scripts", "run-release-gate.ts"),
        "--gate", "base",
        "--out", out,
        "--",
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(childPayload)}); ` +
          "process.stderr.write('raw-secret-stderr'); process.exit(7);"
      ], {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          RELEASE_TAG: workflowBinding.releaseTag,
          SOURCE_COMMIT: workflowBinding.sourceCommit,
          ARTIFACT_SHA512: workflowBinding.artifactSha512,
          WORKFLOW_RUN_URL: workflowBinding.workflowRunUrl,
          WORKFLOW_RUN_ATTEMPT: String(workflowBinding.workflowRunAttempt)
        },
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]);
      expect(exitCode).toBe(7);
      expect(stdout).toBe("Release gate base failed with 3 sanitized outcome(s).\n");
      expect(stderr).toBe("");
      expect(stdout).not.toContain("raw-run-id");
      expect(stdout).not.toContain("raw model-authored content");
      expect(stderr).not.toContain("raw-secret-stderr");

      const persisted = JSON.parse(await readFile(out, "utf8")) as {
        status: string;
        outcomes: Array<{ provider?: string; status: string; error?: Record<string, unknown> }>;
      };
      expect(persisted.status).toBe("failed");
      expect(persisted.outcomes.map((outcome) => [outcome.provider, outcome.status])).toEqual([
        ["meta", "passed"],
        ["qwen", "failed"],
        ["openai", "passed"]
      ]);
      expect(persisted.outcomes[1]?.error).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        category: "provider",
        retryable: true
      });
      expect(JSON.stringify(persisted)).not.toContain("raw qwen payload");
      expect(JSON.stringify(persisted)).not.toContain("raw-run-id");

      const summary = await summarizeReleaseGates({
        title: "Provider outcomes",
        diagnosticsDirectory: directory,
        expectedBinding: workflowBinding,
        gates: [{ name: "base", outcome: "failure" }]
      });
      expect(summary.rows[0]?.detail).toContain("meta: passed");
      expect(summary.rows[0]?.detail).toContain(
        "qwen: PROVIDER_UNAVAILABLE [category=provider, retryable=true]"
      );
      expect(summary.rows[0]?.detail).toContain("openai: passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
