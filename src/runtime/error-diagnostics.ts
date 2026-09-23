import { z } from "zod";
import { HARNESS_ERROR_CODES } from "./errors.js";

const systemCodes = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EISDIR", "ENOTDIR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"] as const;
const kinds = ["AssertionError", "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError", "GuardrailTriggeredError", "ProviderToolCallError", "ProviderHTTPError", "ValidationError", "ParseError", "ToolNotRegisteredError"] as const;
const providerToolCallReasons = ["empty_arguments", "invalid_json", "arguments_too_large", "incomplete_arguments", "inconsistent_metadata", "response_failed", "response_incomplete", "stream_truncated"] as const;
const guardrailStages = ["input", "output", "tool-input", "tool-output"] as const;
const compactionReasons = ["invalid_max_messages", "invalid_max_estimated_input_tokens", "invalid_keep_recent_messages", "missing_limits", "protected_messages", "empty_summary", "insufficient_reduction", "max_messages_exceeded", "max_estimated_input_tokens_exceeded"] as const;
// Exact fixed SDK ValidationError messages only: substrings could misclassify
// arbitrary provider text and must never be emitted as diagnostics.
const compactionMessages = new Map<string, typeof compactionReasons[number]>([
  ["Agent compaction maxMessages must be an integer greater than or equal to 2.", "invalid_max_messages"],
  ["Agent compaction maxEstimatedInputTokens must be a positive integer.", "invalid_max_estimated_input_tokens"],
  ["Agent compaction keepRecentMessages must be a positive integer.", "invalid_keep_recent_messages"],
  ["Agent compaction requires maxMessages or maxEstimatedInputTokens.", "missing_limits"],
  ["Agent compaction cannot satisfy its limits without removing protected messages.", "protected_messages"],
  ["Agent compactor returned an empty summary.", "empty_summary"],
  ["Agent compaction must reduce both message count and estimated input tokens.", "insufficient_reduction"],
  ["Agent compaction result still exceeds maxMessages.", "max_messages_exceeded"],
  ["Agent compaction result still exceeds maxEstimatedInputTokens.", "max_estimated_input_tokens_exceeded"]
]);
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
const checkpoints = ["request_status", "request_approval", "request_arguments", "request_persistence", "resume_state", "resume_arguments", "resume_status", "resume_output", "resume_effect", "resume_journal", "orchestration_status", "orchestration_output", "orchestration_delegation", "orchestration_child", "orchestration_budget", "orchestration_reopen"] as const;
const acceptanceReasons = ["parent_missing_child", "parent_child_failed", "parent_child_marker", "child_missing_read", "child_missing_marker", "child_missing_read_and_marker"] as const;
const approvalFields = ["proposalId", "change_count", "path", "content", "expectedDigest", "unknown_fields", "shape"] as const;
const issueCodes = ["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"] as const;

export const errorDetailsSchema = z.strictObject({
  chain: z.array(z.strictObject({
    kind: z.enum(kinds).optional(),
    checkpoint: z.enum(checkpoints).optional(),
    code: z.enum([...HARNESS_ERROR_CODES, ...systemCodes]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean().optional(),
    providerToolCallReason: z.enum(providerToolCallReasons).optional(),
    category: z.literal("provider-tool-call").optional(),
    effectsPossible: z.boolean().optional(),
    guardrailStage: z.enum(guardrailStages).optional(),
    compactionReason: z.enum(compactionReasons).optional(),
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
  const seen = new Set<object>();
  let current = error;
  let validation: z.infer<typeof errorDetailsSchema>["validation"];
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
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
    if (typeof status === "number") entry.status = status;
    if (typeof record.retryable === "boolean") entry.retryable = record.retryable;
    // The SDK's durable AgentRunError keeps category/reason but has no name.
    if (record.name === "ProviderToolCallError" || record.category === "provider-tool-call") {
      if (record.category === "provider-tool-call") entry.category = "provider-tool-call";
      if (providerToolCallReasons.includes(record.reason as typeof providerToolCallReasons[number])) {
        entry.providerToolCallReason = record.reason as typeof providerToolCallReasons[number];
      }
      if (typeof record.effectsPossible === "boolean") entry.effectsPossible = record.effectsPossible;
    }
    if (record.name === "ValidationError" && typeof record.message === "string") {
      const reason = compactionMessages.get(record.message);
      if (reason) entry.compactionReason = reason;
    }
    if (record.name === "GuardrailTriggeredError") {
      if (guardrailStages.includes(record.stage as typeof guardrailStages[number])) entry.guardrailStage = record.stage as typeof guardrailStages[number];
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
  return { chain, ...(validation ? { validation } : {}) };
};
