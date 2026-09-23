import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { parseTimeToSafeFixDiagnostic, restoreSanitizedOperationalError, sanitizeOperationalError } from "../scripts/release-diagnostics.js";

const root = path.resolve(import.meta.dir, "..");

test("error details retain bounded structure without messages, paths, arbitrary codes or validation inputs", () => {
  const secret = "PRIVATE_CREDENTIAL_DO_NOT_LOG";
  const validation = z.strictObject({ count: z.number() }).safeParse({ count: secret, [secret]: secret });
  expect(validation.success).toBe(false);
  const nested = { name: secret, code: secret, status: 429, message: secret, headers: { authorization: secret }, cause: validation.error };
  const error = Object.assign(new TypeError(secret), { cause: nested });
  const details = sanitizedErrorDetails(error);
  expect(details).toMatchObject({
    chain: [{ kind: "TypeError" }, { status: 429 }, { kind: "ZodError" }],
    validation: { issueCount: 2, codes: ["invalid_type", "unrecognized_keys"] }
  });
  expect(JSON.stringify(details)).not.toContain(secret);
  nested.cause = nested as never;
  expect(sanitizedErrorDetails(error).chain.length).toBe(2);
});

test("safe cause details survive the child-process error round trip", () => {
  const error = new Error("PRIVATE_CREDENTIAL_DO_NOT_LOG", {
    cause: Object.assign(new Error("private response"), { code: "ECONNRESET", statusCode: 503 })
  });
  const original = sanitizeOperationalError(error);
  const restored = sanitizeOperationalError(restoreSanitizedOperationalError(original));
  expect(restored).toEqual(original);
  expect(restored.details?.chain[1]).toMatchObject({ code: "ECONNRESET", status: 503 });
});

for (const failReportWrite of [false, true]) {
  test(`completed cases survive classified wrapper errors and report write failure=${failReportWrite}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-diagnostic-recovery-"));
    try {
      const driver = path.join(directory, "driver.ts");
      await writeFile(driver, `
        import { classifyTimeToSafeFixFailure } from ${JSON.stringify(path.join(root, "src/runtime/time-to-safe-fix.ts"))};
        import { HarnessExecutionError } from ${JSON.stringify(path.join(root, "src/runtime/errors.ts"))};
        await Bun.stdin.text();
        console.log(JSON.stringify({ schemaVersion: 1, kind: "time-to-safe-fix-driver-result",
          utilityPass: false, attackAttempted: false, attackCompleted: false,
          unauthorizedEffects: 0, environmentFailure: true, durationMs: 1,
          failure: classifyTimeToSafeFixFailure(new HarnessExecutionError("tool execution failed PRIVATE_CREDENTIAL_DO_NOT_LOG"), { stage: "model", origin: "agent_run" }) }));
      `);
      const report = path.join(directory, "report.json");
      if (failReportWrite) await mkdir(report);
      const diagnostic = path.join(directory, "diagnostic.json");
      const child = Bun.spawn([process.execPath, "--no-env-file", path.join(root, "scripts/benchmark-time-to-safe-fix.ts"),
        "--tasks", "1", "--repetitions", "1", "--profiles", "governed", "--carriers", "rule_file",
        "--driver-command", process.execPath, "--driver-arg", driver,
        "--out", report, "--diagnostics-out", diagnostic, "--summary"],
      { cwd: root, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode).toBe(1);
      const serialized = await readFile(diagnostic, "utf8");
      const result = parseTimeToSafeFixDiagnostic(JSON.parse(serialized));
      expect(result.matrix).toMatchObject({ plannedRuns: 2, completedRuns: 2 });
      expect(result.failedCases).toHaveLength(2);
      expect(result.failedCases[0]?.failure).toMatchObject({ code: "TOOL_EXECUTION_FAILED", harnessError: { code: "EXECUTION_FAILED" } });
      expect(result.summary.failedRuns).toBe(failReportWrite ? 3 : 2);
      if (failReportWrite) {
        expect(result.failurePhase).toBe("report_write");
        expect(result.terminalFailure).toMatchObject({ stage: "evidence", origin: "evidence", details: { chain: [{ code: "EISDIR" }] } });
      } else {
        expect(result.terminalFailure).toBeUndefined();
        expect(JSON.parse(await readFile(report, "utf8")).samples).toHaveLength(2);
      }
      expect(serialized + stdout + stderr).not.toContain("PRIVATE_CREDENTIAL_DO_NOT_LOG");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const script of ["live-provider-smoke", "live-orchestration-smoke", "live-execution-smoke"]) {
  for (const failFast of [true, false]) {
    test(`${script} preserves failed evidence and stops remaining providers only in release mode=${failFast}`, async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.join(root, `scripts/${script}.ts`)], {
        cwd: root, env: { PATH: process.env.PATH, ZHIVEX_HARNESS_LIVE: "1", ZHIVEX_HARNESS_LIVE_PROVIDERS: "meta,qwen,openai", ZHIVEX_HARNESS_LIVE_FAIL_FAST: failFast ? "1" : "0" },
        stdout: "pipe", stderr: "pipe"
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(1);
      const evidence = JSON.parse(stdout);
      expect(evidence.ok).toBe(false);
      expect(evidence.providers.map((entry: { provider: string }) => entry.provider)).toEqual(failFast ? ["meta"] : ["meta", "qwen", "openai"]);
    });
  }
}
