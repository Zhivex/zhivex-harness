import { z } from "zod";
import { HARNESS_ERROR_CODES, HarnessError } from "../src/runtime/errors.js";

const category = z.enum(["configuration", "usage", "workspace", "state", "provider", "approval", "execution"]);
const operational = z.object({ code: z.enum(HARNESS_ERROR_CODES), category, retryable: z.boolean() });
export const routingProviderSchema = z.enum(["meta", "qwen", "openai", "anthropic", "gemini", "vertex"]);
const cleanupStage = z.enum(["harness_close", "workspace_cleanup"]);

/** Release-driver evidence only; no model text, paths, IDs, or arbitrary values. */
export const routingDiagnosticSchema = z.strictObject({
  stage: z.enum(["runtime_load", "configuration", "workspace_create", "fixture_prepare", "harness_create", "parent_run", "verification", "child_load", "harness_close", "workspace_cleanup", "evidence_write"]),
  assertion: z.enum(["distinct_providers", "parent_completed", "parent_provider", "delegation_count", "delegation_success", "child_present", "child_tool_budget", "child_tool_errors", "child_completed", "child_provider", "child_model"]).optional(),
  parentProvider: routingProviderSchema.optional(),
  reviewerProvider: routingProviderSchema.optional(),
  cleanupFailures: z.array(z.strictObject({
    stage: cleanupStage,
    code: z.enum(HARNESS_ERROR_CODES), category, retryable: z.boolean(),
    status: z.number().int().min(100).max(599).optional()
  })).max(2).optional()
});
export type RoutingDiagnostic = z.infer<typeof routingDiagnosticSchema>;

// Only driver-created context is eligible for projection; ignore arbitrary error properties.
const contexts = new WeakMap<object, RoutingDiagnostic>();
export const attachRoutingDiagnostic = (error: object, context: RoutingDiagnostic) => {
  contexts.set(error, routingDiagnosticSchema.parse(context));
};
export const routingDiagnosticFor = (error: unknown) => {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const context = contexts.get(current);
    if (context) return context;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** Bundled artifact errors and serialized run errors need not share our class identity. */
export const routingOperationalCause = (error: unknown): unknown => {
  let current = error;
  let fallback: HarnessError | undefined;
  const seen = new Set<object>();
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const typed = operational.safeParse(current);
    if (typed.success) {
      const projected = new HarnessError("Routing operation failed.", { ...typed.data, cause: error });
      if (typed.data.category !== "execution") return projected;
      fallback ??= projected;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return fallback ?? error;
};

export const routingFailure = (error: unknown, context: RoutingDiagnostic) => {
  const failure = new Error("Live routing certification failed.", { cause: routingOperationalCause(error) });
  attachRoutingDiagnostic(failure, context);
  return failure;
};
