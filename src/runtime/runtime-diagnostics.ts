import { z } from "zod";
import { createRedactionPolicy } from "@zhivex-ai/agents";

const count = z.number().int().nonnegative().finite();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable();
const diagnosticsSchema = z.object({ schemaVersion: z.literal(1), profile: z.literal("repair"),
  budget: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, modelCalls: count,
    usageComplete: z.boolean(), inFlight: z.boolean(),
    stopReason: z.enum(["USAGE_UNAVAILABLE", "WORK_TOKEN_BUDGET", "INPUT_TOKEN_BUDGET", "OUTPUT_TOKEN_BUDGET"]).nullable(),
    reservedInputTokens: count, reservedOutputTokens: count, predictedInputTokens: count, outputCapApplied: z.boolean().default(false) }),
  phase: z.enum(["explore", "reproduce", "candidate", "verify", "recover", "delivered", "incomplete"]),
  candidate: digest, revision: count,
  checks: z.array(z.object({ commandId: z.string().max(128), purpose: z.string().max(500),
    argvDigest: digest, candidate: digest, exitCode: z.number().int(), verified: z.boolean() })).max(8),
  contextMeasurements: z.array(z.object({ systemCharacters: count, userCharacters: count, assistantCharacters: count,
    toolResultCharacters: count, otherMessageCharacters: count, toolDefinitionCharacters: count, unmeasuredToolDefinitions: count })).max(128),
  modelTimings: z.array(z.object({ durationMs: z.number().nonnegative().finite(), firstTokenMs: z.number().nonnegative().finite().nullable(), completed: z.boolean() })).max(128),
  omittedContextMeasurements: count
});
const manifestSchema = z.object({ schemaVersion: z.literal(1), policyVersion: z.literal("repair-v2-durable-closure"),
  role: z.string().max(128), profile: z.enum(["strict", "repair"]), backend: z.enum(["none", "oci"]),
  tools: z.array(z.string().max(128)).max(1024),
  budget: z.object({ maxSteps: count, maxToolCalls: count, maxToolErrors: count, maxInputTokens: count, maxOutputTokens: count, includeChildRuns: z.boolean() }),
  timeoutMs: count, closureController: z.boolean(), contextEnabled: z.boolean() });
const redact = createRedactionPolicy({ includeEmails: true });
/** Parse and project an allowlist; persisted user metadata is not trusted output. */
export const inspectRuntimeDiagnostics = (value: unknown) => {
  const parsed = diagnosticsSchema.safeParse(value);
  if (!parsed.success) return null;
  return { ...parsed.data, checks: parsed.data.checks.map(check => ({ ...check,
    commandId: redact.redactText(check.commandId), purpose: redact.redactText(check.purpose) })) };
};
export const inspectRuntimeManifest = (value: unknown) => {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) return null;
  return { ...parsed.data, role: redact.redactText(parsed.data.role), tools: parsed.data.tools.map(name => redact.redactText(name)) };
};
