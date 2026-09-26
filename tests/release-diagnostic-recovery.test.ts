import { liveProviderSmokeInternals } from "../scripts/live-provider-smoke.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { parseTimeToSafeFixDiagnostic, restoreSanitizedOperationalError, sanitizeOperationalError } from "../scripts/release-diagnostics.js";

const root = path.resolve(import.meta.dir, "..");

test("guardrail budget diagnostics retain finite counters without private metadata", () => {
  const secret = "PRIVATE_CREDENTIAL_DO_NOT_LOG";
  const error = Object.assign(new Error(secret), {
    name: "GuardrailTriggeredError",
    metadata: { budgetLimit: "maxToolCalls", limit: 1, actual: 0, required: 3,
      remaining: 1, operation: "tool", includeChildRuns: false,
      prompt: secret, responseBody: secret, nested: { authorization: secret } }
  });
  const original = sanitizeOperationalError(error);
  expect(original.details?.chain).toEqual([{ kind: "GuardrailTriggeredError", budget: {
    budgetLimit: "maxToolCalls", limit: 1, actual: 0, required: 3, remaining: 1,
    operation: "tool", includeChildRuns: false
  } }]);
  expect(JSON.stringify(original)).not.toContain(secret);
  expect(sanitizeOperationalError(restoreSanitizedOperationalError(original))).toEqual(original);
  for (const invalid of [secret, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(sanitizedErrorDetails({ ...error, metadata: { ...error.metadata, required: invalid } }).chain)
      .toEqual([{ kind: "GuardrailTriggeredError" }]);
  }
  expect(sanitizedErrorDetails({ ...error, metadata: { ...error.metadata, budgetLimit: secret } }).chain)
    .toEqual([{ kind: "GuardrailTriggeredError" }]);
});

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

test("live assertion checkpoints survive sanitization without copying arbitrary checkpoint text", () => {
  const error = Object.assign(new Error("private model response"), {
    checkpoint: "resume_output",
    cause: Object.assign(new Error("private assertion values"), { name: "AssertionError" })
  });
  const original = sanitizeOperationalError(error);
  expect(sanitizeOperationalError(restoreSanitizedOperationalError(original))).toEqual(original);
  expect(original.details?.chain).toEqual([
    { kind: "Error", checkpoint: "resume_output" }, { kind: "AssertionError" }
  ]);
  error.checkpoint = "PRIVATE_CREDENTIAL_DO_NOT_LOG";
  expect(JSON.stringify(sanitizeOperationalError(error))).not.toContain("PRIVATE_CREDENTIAL_DO_NOT_LOG");
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


test("approval mismatch diagnostics classify fields without retaining argument content", () => {
  const expected = { proposalId: "fixture-id", changes: [{ path: "fixture.txt", content: "expected", expectedDigest: null }] };
  let failure: unknown;
  try {
    liveProviderSmokeInternals.assertApprovalArguments({ proposalId: "fixture-id", changes: [{ path: "fixture.txt", content: "PRIVATE_PAYLOAD", expectedDigest: null }] }, expected);
  } catch (error) { failure = error; }
  const details = sanitizedErrorDetails(failure);
  expect(details.chain[0]?.approvalFields).toEqual(["content"]);
  expect(JSON.stringify(details)).not.toContain("PRIVATE_PAYLOAD");
  expect(sanitizedErrorDetails({ approvalFields: ["PRIVATE_PAYLOAD", "content", "content"] }).chain).toEqual([{ approvalFields: ["content"] }]);
});

test("orchestration checkpoints survive recovery without retaining assertion content", () => {
  for (const checkpoint of ["orchestration_status", "orchestration_output", "orchestration_delegation", "orchestration_child", "orchestration_budget", "orchestration_reopen"] as const) {
    const error = Object.assign(new Error("private model output"), { checkpoint, cause: Object.assign(new Error("private assertion"), {name:"AssertionError"}) });
    const safe = sanitizeOperationalError(error);
    expect(safe.details?.chain?.[0]?.checkpoint).toBe(checkpoint);
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
  }
  expect(JSON.stringify(sanitizeOperationalError({checkpoint:"private model output"}))).not.toContain("private");
});

test("wrapped typed stream failures retain delegation reason at serialization", () => {
  const cause = Object.assign(new Error("private output"), { name:"GuardrailTriggeredError", metadata:{delegation:"acceptance",payload:"private output"} });
  const outer = Object.assign(new Error("private wrapper"), {checkpoint:"orchestration_status",cause});
  const safe = sanitizeOperationalError(outer);
  expect(safe.details?.chain).toEqual([{kind:"Error",checkpoint:"orchestration_status"},{kind:"GuardrailTriggeredError",delegation:"acceptance"}]);
  expect(JSON.stringify(safe)).not.toContain("private");
});

for (const checkpoint of ["execution_approval_tool", "execution_command_arguments", "execution_import_reference", "execution_run_status", "execution_completion_marker", "execution_approval_sequence", "execution_tool_sequence", "execution_tool_success", "execution_host_content", "execution_environment_binding", "execution_journal"] as const) {
  test(`execution checkpoint survives the release diagnostic boundary: ${checkpoint}`, () => {
    const error = Object.assign(new Error("PRIVATE_PROVIDER_OUTPUT"), { checkpoint,
      cause: Object.assign(new Error("PRIVATE_ASSERTION_ARGUMENTS"), { name: "AssertionError", actual: "PRIVATE_ACTUAL", expected: "PRIVATE_EXPECTED" }) });
    const safe = sanitizeOperationalError(error);
    expect(safe.details?.chain).toEqual([{ kind: "Error", checkpoint }, { kind: "AssertionError" }]);
    expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_");
  });
}

const goodReceipt = { toolName: "apply_patch", isError: false };
const goodJournal = { toolName: "apply_patch", status: "completed" };
for (const [checkpoint, results, journal, content] of [
  ["resume_result_count", [], [goodJournal], "ok"],
  ["resume_result_count", [{ ...goodReceipt, isError: true }, goodReceipt], [goodJournal], "ok"],
  ["resume_result_success", [{ ...goodReceipt, isError: true }], [], "ok"],
  ["resume_file_content", [goodReceipt], [goodJournal], "PRIVATE_WRONG_CONTENT"],
  ["resume_journal_count", [goodReceipt], [], "ok"],
  ["resume_journal_count", [goodReceipt], [goodJournal, goodJournal], "ok"],
  ["resume_journal_status", [goodReceipt], [{ ...goodJournal, status: "failed" }], "ok"]
] as const) {
  test(`live edit diagnostic distinguishes ${checkpoint} with ${results.length} receipts and ${journal.length} journal entries`, async () => {
    try {
      await liveProviderSmokeInternals.assertResumeEffect(results, journal, async () => content, "ok");
      throw new Error("Expected a rejected effect");
    } catch (error) {
      const safe = sanitizeOperationalError(error);
      expect(safe.details?.chain?.[0]).toMatchObject({ checkpoint, editEffect: {
        resultReceipts: results.length,
        errorReceipts: results.filter(result => result.isError).length,
        successReceipts: results.filter(result => !result.isError).length,
        journalEntries: journal.length,
        completedJournalEntries: journal.filter(entry => entry.status === "completed").length
      } });
      expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
      expect(JSON.stringify(safe)).not.toContain("PRIVATE_WRONG_CONTENT");
    }
  });
}

test("live edit file-read failures remain distinct and successful effects preserve the acceptance contract", async () => {
  await expect(liveProviderSmokeInternals.assertResumeEffect([goodReceipt], [goodJournal], async () => "ok", "ok"))
    .resolves.toEqual({ toolExecutions: 1, journalEntries: 1 });
  try {
    await liveProviderSmokeInternals.assertResumeEffect([goodReceipt], [goodJournal], async () => {
      throw Object.assign(new Error("PRIVATE_PATH"), { code: "ENOENT" });
    }, "ok");
    throw new Error("Expected read failure");
  } catch (error) {
    const safe = sanitizeOperationalError(error);
    expect(safe.details?.chain?.[0]?.checkpoint).toBe("resume_file_read");
    expect(safe.details?.chain?.[1]?.code).toBe("ENOENT");
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_PATH");
  }
});

test("edit effect diagnostics reject invalid counters and strip arbitrary payloads", () => {
  const counts = { resultReceipts: 2, errorReceipts: 1, successReceipts: 1, journalEntries: 1, completedJournalEntries: 1 };
  expect(sanitizedErrorDetails({editEffect:{...counts,secret:"PRIVATE"}}).chain).toEqual([{editEffect:counts}]);
  for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "PRIVATE"]) {
    expect(sanitizedErrorDetails({editEffect:{...counts,resultReceipts:value}}).chain).toEqual([]);
  }
});
