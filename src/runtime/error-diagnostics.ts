import { z } from "zod";
import { HARNESS_ERROR_CODES } from "./errors.js";

const systemCodes = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EISDIR", "ENOTDIR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"] as const;
const kinds = ["AssertionError", "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError"] as const;
const checkpoints = ["request_status", "request_approval", "request_arguments", "request_persistence", "resume_state", "resume_arguments", "resume_status", "resume_output", "resume_effect", "resume_journal"] as const;
const issueCodes = ["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"] as const;

export const errorDetailsSchema = z.strictObject({
  chain: z.array(z.strictObject({
    kind: z.enum(kinds).optional(),
    checkpoint: z.enum(checkpoints).optional(),
    code: z.enum([...HARNESS_ERROR_CODES, ...systemCodes]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean().optional()
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
    if (checkpoints.includes(record.checkpoint as typeof checkpoints[number])) entry.checkpoint = record.checkpoint as typeof checkpoints[number];
    if (kinds.includes(record.name as typeof kinds[number])) entry.kind = record.name as typeof kinds[number];
    const allowedCodes: readonly unknown[] = [...HARNESS_ERROR_CODES, ...systemCodes];
    if (allowedCodes.includes(record.code)) entry.code = record.code as NonNullable<typeof entry.code>;
    const status = [record.status, record.statusCode].find((value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
    if (typeof status === "number") entry.status = status;
    if (typeof record.retryable === "boolean") entry.retryable = record.retryable;
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
