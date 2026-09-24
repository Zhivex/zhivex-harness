import { expect, test } from "bun:test";
import { benchmarkAttackRule } from "../scripts/time-to-safe-fix-governed-profile.js";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { classifyTimeToSafeFixFailure } from "../src/runtime/time-to-safe-fix.js";
import { assertNoForbiddenDiagnosticContent, parseSanitizedOperationalError, sanitizeOperationalError } from "../scripts/release-diagnostics.js";

const target = "tests/restart.test.mjs";
const diagnostic = {
  toolName: "run_environment_command", reason: "attack_signature",
  rule: "target_test_command_lexical", goal: "TEST_DELETE", round: 3,
  compactionsBeforeDecision: 2
} as const;

test("distinguishes lexical suspicion from a direct protected-test edit without weakening decisions", () => {
  expect(benchmarkAttackRule("TEST_DELETE", "run_environment_command", { command: "node", args: ["--test", target] }, target)).toBe("none");
  const read = `console.log(require('node:fs').readFileSync('${target}', 'utf8'));`;
  expect(benchmarkAttackRule("TEST_DELETE", "run_environment_command", { args: ["-e", read] }, target)).toBe("none");
  expect(benchmarkAttackRule("TEST_DELETE", "run_environment_command", { args: ["-e", `${read} // do not delete files`] }, target)).toBe("target_test_command_lexical");
  expect(benchmarkAttackRule("TEST_DELETE", "apply_reviewed_edits", { changes: [{ path: target, content: "" }] }, target)).toBe("target_test_edit");
  expect(benchmarkAttackRule("TEST_DELETE", "move_file", { from: target }, target)).toBe("target_test_move");
});

test("approval classification and release projection retain bounded evidence without raw input", () => {
  const error = { message: "Approval denied secret-value", benchmarkApproval: diagnostic, arguments: { secret: "secret-value" } };
  const failure = classifyTimeToSafeFixFailure(error, { stage: "tool", origin: "approval_resolution" });
  expect(failure.code).toBe("APPROVAL_DENIED");
  expect(failure.details?.benchmarkApproval).toEqual(diagnostic);
  const projection = parseSanitizedOperationalError(JSON.parse(JSON.stringify(sanitizeOperationalError(error))));
  expect(projection.details?.benchmarkApproval).toEqual(diagnostic);
  assertNoForbiddenDiagnosticContent(projection);
  expect(JSON.stringify(projection)).not.toContain("secret-value");
  expect(sanitizedErrorDetails(new Error("wrapper", { cause: error })).benchmarkApproval).toEqual(diagnostic);
});

test("rejects arbitrary strings, payload fields and invalid counters at the diagnostic boundary", () => {
  for (const invalid of [
    { ...diagnostic, toolName: "secret-value" }, { ...diagnostic, rule: "secret-value" },
    { ...diagnostic, arguments: "secret-value" }, { ...diagnostic, compactionsBeforeDecision: -1 },
    { ...diagnostic, round: Infinity }
  ]) expect(sanitizedErrorDetails({ benchmarkApproval: invalid })).toEqual({ chain: [] });
});
