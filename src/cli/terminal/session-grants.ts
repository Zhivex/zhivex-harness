import type { AgentApprovalRequest } from "@zhivex-ai/agents";

/** Never grant by command prefix or tool name alone. Unknown payload fields
 * prevent reuse so an expanded tool contract cannot inherit an old grant. */
export function checkApprovalGrant(approval: AgentApprovalRequest, workspace: string): string | undefined {
  if (approval.kind !== "local-tool" || approval.name !== "run_check") return;
  try {
    const args: unknown = JSON.parse(approval.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    const value = args as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "check,expectedScript" ||
      typeof value.check !== "string" || typeof value.expectedScript !== "string" || !value.expectedScript.trim()) return;
    return JSON.stringify([workspace, approval.provider, approval.childAgentId ?? "", approval.name, value.check, value.expectedScript]);
  } catch { return; }
}
