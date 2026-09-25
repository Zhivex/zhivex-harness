import { createHash } from "node:crypto";
import type { ToolSet } from "@zhivex-ai/core";
import { z } from "zod";
import { workspaceFilePathSchema } from "../workspace/edit-contracts.js";

const normalizedPath = workspaceFilePathSchema.refine((value) => !value.includes("\\"), "Use forward slashes.");
const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const harnessToolPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(z.strictObject({
    id: nameSchema,
    tools: z.array(nameSchema).min(1).max(128),
    paths: z.array(normalizedPath).min(1).max(256).optional(),
    decision: z.enum(["allow", "ask_user", "deny"]),
    reason: z.string().min(1).max(512)
  })).max(128)
}).superRefine((policy, context) => {
  if (new Set(policy.rules.map((rule) => rule.id)).size !== policy.rules.length) {
    context.addIssue({ code: "custom", message: "Tool policy rule ids must be unique." });
  }
});
export type HarnessToolPolicy = z.infer<typeof harnessToolPolicySchema>;
export type HarnessToolPolicyDecision = {
  decision: "allow" | "ask_user" | "deny";
  ruleIds: string[];
  reason: string;
};
const rank = { allow: 0, ask_user: 1, deny: 2 } as const;

/** Trusted application configuration only. No rule can grant a missing permission. */
export const createHarnessToolPolicy = (input: HarnessToolPolicy) => {
  const policy = harnessToolPolicySchema.parse(input);
  const canonical = { schemaVersion: 1, rules: policy.rules.map((rule) => ({
    ...rule, tools: [...new Set(rule.tools)].sort(), ...(rule.paths ? { paths: [...new Set(rule.paths)].sort() } : {})
  })).sort((a, b) => a.id.localeCompare(b.id)) };
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
  const evaluate = (request: { toolName: string; paths?: readonly string[]; requiresApproval?: boolean; hardDenied?: boolean }): HarnessToolPolicyDecision => {
    if (request.hardDenied) return { decision: "deny", ruleIds: [], reason: "Denied by the harness permission boundary." };
    const paths = request.paths?.map((value) => normalizedPath.parse(value)) ?? [];
    if (paths.length === 0 && canonical.rules.some((rule) => rule.tools.includes(request.toolName) && rule.paths)) {
      return { decision: "deny", ruleIds: [], reason: "Path-scoped policy cannot evaluate a request without resolved paths." };
    }
    const matching = canonical.rules.filter((rule) => rule.tools.includes(request.toolName) &&
      (!rule.paths || paths.some((target) => rule.paths?.includes(target))));
    let decision: HarnessToolPolicyDecision["decision"] = request.requiresApproval ? "ask_user" : "allow";
    for (const rule of matching) if (rank[rule.decision] > rank[decision]) decision = rule.decision;
    const decisive = matching.filter((rule) => rule.decision === decision);
    return { decision, ruleIds: decisive.map((rule) => rule.id), reason: decisive.length > 0
      ? decisive.map((rule) => rule.reason).join("; ")
      : request.requiresApproval ? "Existing tool approval is required." : "No additional restriction from application policy." };
  };
  return { digest, evaluate, policy: structuredClone(canonical) };
};

export class HarnessToolPolicyDeniedError extends Error {
  constructor(readonly policyDecision: HarnessToolPolicyDecision) {
    super(`Tool denied by application policy${policyDecision.ruleIds.length ? ` (${policyDecision.ruleIds.join(", ")})` : ""}: ${policyDecision.reason}`);
    this.name = "HarnessToolPolicyDeniedError";
  }
}

/**
 * Retains original executors and hard permission checks. SDK approval metadata is
 * static, so a path-scoped ask rule conservatively requires approval for the whole
 * named tool. Paths must be extracted by trusted, tool-specific integration code.
 */
export const applyHarnessToolPolicy = (tools: ToolSet, input: HarnessToolPolicy, options: {
  resolvePaths?: (toolName: string, input: unknown) => readonly string[];
  onDecision?: (toolName: string, decision: HarnessToolPolicyDecision) => void | Promise<void>;
} = {}): ToolSet => {
  const engine = createHarnessToolPolicy(input);
  if (engine.policy.rules.some((rule) => rule.paths) && !options.resolvePaths) {
    throw new Error("Path-scoped tool policy requires a trusted resolvePaths callback.");
  }
  const result: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const additionalApproval = engine.policy.rules.some((rule) => rule.tools.includes(name) && rule.decision === "ask_user");
    const requiresApproval = definition.requiresApproval === true || additionalApproval;
    const execute = "execute" in definition ? definition.execute : undefined;
    if (!execute && engine.policy.rules.some((rule) => rule.tools.includes(name))) {
      throw new Error(`Tool policy cannot wrap provider-executed tool ${name}.`);
    }
    result[name] = {
      ...definition,
      ...(requiresApproval ? { independent: false, requiresApproval: true, approvalMode: "interrupt" as const,
        approvalVersion: `${("approvalVersion" in definition ? definition.approvalVersion : undefined) ?? "policy"}:${engine.digest}` } : {}),
      metadata: { ...definition.metadata, harnessToolPolicyDigest: engine.digest },
      ...(execute ? { execute: async (toolInput, context) => {
        const decision = engine.evaluate({ toolName: name,
          ...(options.resolvePaths ? { paths: options.resolvePaths(name, toolInput) } : {}),
          requiresApproval });
        await options.onDecision?.(name, decision);
        if (decision.decision === "deny") throw new HarnessToolPolicyDeniedError(decision);
        return execute(toolInput, context);
      } } : {})
    };
  }
  return result;
};
