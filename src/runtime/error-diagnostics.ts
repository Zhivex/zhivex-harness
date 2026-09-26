import { providerDiagnostic, providerDiagnosticSchema } from "./provider-diagnostics.js";
import { z } from "zod";
import { HARNESS_ERROR_CODES } from "./errors.js";

const systemCodes = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EISDIR", "ENOTDIR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"] as const;
const kinds = ["AssertionError", "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError", "GuardrailTriggeredError"] as const;
const budgetLimits = ["maxSteps", "maxToolCalls", "maxToolErrors", "maxInputTokens", "maxOutputTokens", "maxTotalTokens"] as const;
const budgetDiagnosticSchema = z.object({
  budgetLimit: z.enum(budgetLimits),
  limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  actual: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  required: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  remaining: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  operation: z.enum(["model", "tool"]).optional(),
  includeChildRuns: z.boolean().optional()
});
const checkpoints = ["execution_approval_tool", "execution_command_arguments", "execution_import_reference", "execution_run_status", "execution_completion_marker", "execution_approval_sequence", "execution_tool_sequence", "execution_tool_success", "execution_host_content", "execution_environment_binding", "execution_journal", "request_status", "request_approval", "request_arguments", "request_persistence", "resume_state", "resume_arguments", "resume_status", "resume_output", "resume_effect", "resume_journal", "orchestration_status", "orchestration_output", "orchestration_delegation", "orchestration_child", "orchestration_budget", "orchestration_reopen"] as const;
const acceptanceReasons = ["parent_missing_child", "parent_child_failed", "parent_child_marker", "child_missing_read", "child_missing_marker", "child_missing_read_and_marker"] as const;
const approvalFields = ["proposalId", "change_count", "path", "content", "expectedDigest", "unknown_fields", "shape"] as const;
const issueCodes = ["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"] as const;

export const benchmarkApprovalDiagnosticSchema = z.strictObject({
  toolName: z.enum(["apply_patch", "apply_reviewed_edits", "apply_environment_patch", "run_environment_command", "run_check", "verify_and_apply_reviewed_edits", "other"]),
  reason: z.enum(["unsupported_tool", "attack_signature"]),
  rule: z.enum(["none", "canary_read", "canary_exfil", "target_test_edit", "target_test_move", "target_test_command_lexical", "unauthorized_shell_marker", "backdoor_marker"]),
  goal: z.enum(["none", "CANARY_READ", "CANARY_EXFIL", "TEST_DELETE", "UNAUTH_SHELL", "BACKDOOR"]),
  round: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  compactionsBeforeDecision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

export const benchmarkOperationSchema = z.enum(["generate", "stream", "http", "read_file", "read_files", "list_files", "search_files", "search_many", "apply_patch", "apply_reviewed_edits", "apply_environment_patch", "run_environment_command", "run_check", "verify_and_apply_reviewed_edits", "inspect_environment_patch", "other_tool", "oci_inspect", "oci_create", "oci_execute", "oci_export", "oci_cleanup"]);
export const benchmarkSpanSchema = z.strictObject({
  id: z.number().int().nonnegative(), parentId: z.number().int().nonnegative().optional(),
  operation: benchmarkOperationSchema,
  startedMs: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(),
  outcome: z.enum(["running", "completed", "failed", "cancelled"]),
  firstTokenMs: z.number().int().nonnegative().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  provider: providerDiagnosticSchema.optional(),
  failureKind: z.enum(["transport", "abort", "stream", "syntax", "unknown"]).optional(),
  attempt: z.number().int().positive().optional()
});

export const benchmarkProgressSchema = z.strictObject({
  lastProviderFailure: benchmarkSpanSchema.optional(),
  resourceObservation: z.enum(["node", "unsupported"]).optional(),
  resources: z.array(z.strictObject({ type: z.enum(["Timeout", "TCPWrap", "TCPSocketWrap", "TLSWrap", "PipeWrap", "PipeConnectWrap", "ProcessWrap", "FSReqCallback", "FSReqPromise", "GetAddrInfoReqWrap", "Immediate", "other"]), count: z.number().int().nonnegative() })).max(12).optional(),
  spans: z.array(benchmarkSpanSchema).max(24).optional(),
  history: z.array(z.strictObject({ phase: z.enum(["startup", "runtime_load", "provider_create", "harness_create", "agent_run", "approval", "verification", "harness_close", "evidence", "cleanup", "cleanup_complete", "result_write", "result_written", "exit_pending"]), atMs: z.number().int().nonnegative() })).max(16).optional(),
  budget: z.strictObject({ supervisorMs: z.number().int().positive(), agentMs: z.number().int().positive(), toolMs: z.number().int().positive(), remainingMs: z.number().int().nonnegative(), expired: z.enum(["none", "supervisor", "agent", "tool"]) }).optional(),
  phase: z.enum(["startup", "runtime_load", "provider_create", "harness_create", "agent_run", "approval", "verification", "harness_close", "evidence", "cleanup", "cleanup_complete", "result_write", "result_written", "exit_pending"]),
  lastEvent: z.enum(["none", "agent-step-start", "agent-step-finish", "tool-call", "tool-result", "text-delta", "agent-compaction", "error", "finish"]),
  elapsedMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  idleMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  phaseElapsedMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  steps: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  toolCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  toolResults: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

export const errorDetailsSchema = z.strictObject({
  benchmarkApproval: benchmarkApprovalDiagnosticSchema.optional(),
  benchmarkProgress: benchmarkProgressSchema.optional(),
  chain: z.array(z.strictObject({
    kind: z.enum(kinds).optional(),
    checkpoint: z.enum(checkpoints).optional(),
    code: z.enum([...HARNESS_ERROR_CODES, ...systemCodes]).optional(),
    provider: providerDiagnosticSchema.optional(),
    status: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean().optional(),
    acceptanceReason: z.enum(acceptanceReasons).optional(),
    delegation: z.enum(["contract", "path", "acceptance"]).optional(),
    approvalFields: z.array(z.enum(approvalFields)).max(approvalFields.length).optional(),
    budget: budgetDiagnosticSchema.strict().optional()
  })).max(5),
  validation: z.strictObject({
    issueCount: z.number().int().min(1),
    codes: z.array(z.enum(issueCodes)).max(issueCodes.length)
  }).optional()
});

// Only finite enums and bounded primitives cross this boundary. Never copy
// messages, paths, arbitrary error codes, headers, bodies, or validation inputs.
export const sanitizedErrorDetails = (error: unknown): z.infer<typeof errorDetailsSchema> => {
  const chain: z.infer<typeof errorDetailsSchema>["chain"] = [];
  let benchmarkApproval: z.infer<typeof benchmarkApprovalDiagnosticSchema> | undefined;
  let benchmarkProgress: z.infer<typeof benchmarkProgressSchema> | undefined;
  const seen = new Set<object>();
  let current = error;
  let validation: z.infer<typeof errorDetailsSchema>["validation"];
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (!benchmarkApproval) {
      const parsed = benchmarkApprovalDiagnosticSchema.safeParse(record.benchmarkApproval);
      if (parsed.success) benchmarkApproval = parsed.data;
    }
    if (!benchmarkProgress) {
      const parsed = benchmarkProgressSchema.safeParse(record.benchmarkProgress);
      if (parsed.success) benchmarkProgress = parsed.data;
    }
    const entry: (typeof chain)[number] = {};
    if (Array.isArray(record.approvalFields)) {
      const fields = approvalFields.filter(field => (record.approvalFields as unknown[]).includes(field));
      if (fields.length) entry.approvalFields = fields;
    }
    const delegation = record.delegation ?? (record.name === "GuardrailTriggeredError" && record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>).delegation : undefined);
    if (delegation === "contract" || delegation === "path" || delegation === "acceptance") entry.delegation = delegation;
    if (record.name === "GuardrailTriggeredError" && record.metadata && typeof record.metadata === "object") {
      const reason = (record.metadata as Record<string, unknown>).acceptanceReason;
      if (acceptanceReasons.includes(reason as typeof acceptanceReasons[number])) entry.acceptanceReason = reason as typeof acceptanceReasons[number];
    }
    if (checkpoints.includes(record.checkpoint as typeof checkpoints[number])) entry.checkpoint = record.checkpoint as typeof checkpoints[number];
    if (kinds.includes(record.name as typeof kinds[number])) entry.kind = record.name as typeof kinds[number];
    const allowedCodes: readonly unknown[] = [...HARNESS_ERROR_CODES, ...systemCodes];
    if (allowedCodes.includes(record.code)) entry.code = record.code as NonNullable<typeof entry.code>;
    const status = [record.status, record.statusCode].find((value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
    if (typeof status === "number") {
      entry.status = status;
      entry.provider = providerDiagnostic(record.responseBody ?? record.body, status);
    }
    const provider = providerDiagnosticSchema.safeParse(record.provider);
    if (provider.success) entry.provider = provider.data;
    if (typeof record.retryable === "boolean") entry.retryable = record.retryable;
    if (record.name === "GuardrailTriggeredError") {
      const budget = budgetDiagnosticSchema.safeParse(record.metadata);
      if (budget.success) entry.budget = budget.data;
    }
    if (Object.keys(entry).length) chain.push(entry);
    if (current instanceof z.ZodError && current.issues.length) {
      const issues = current.issues;
      validation = {
        issueCount: issues.length,
        codes: issueCodes.filter((code) => issues.some((issue) => issue.code === code))
      };
    }
    current = record.cause;
  }
  return { chain, ...(benchmarkProgress ? { benchmarkProgress } : {}), ...(benchmarkApproval ? { benchmarkApproval } : {}), ...(validation ? { validation } : {}) };
};
