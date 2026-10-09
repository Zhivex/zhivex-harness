import type { AgentRunOutput } from "@zhivex-ai/agents";
import { verificationCounts } from "../terminal/terminal-ui.js";

/** One honest line. Errors and rejections stay visible. Checks are named only when receipts exist. */
export const formatConsoleOutcome = (result: Pick<AgentRunOutput, "status" | "toolResults"> & {state?: Pick<AgentRunOutput["state"], "approvalHistory">},
  appliedFiles: number, denied: number) => {
  const rejections = result.state?.approvalHistory?.filter(item => !item.approve) ?? [];
  const rejectedCalls = new Set(rejections.flatMap(item => item.toolCallId ? [item.toolCallId] : []));
  const failed = result.toolResults.filter(item => item.isError && !rejectedCalls.has(item.toolCallId)).length;
  const rejected = Math.max(denied, rejections.length);
  const counts = verificationCounts(result.toolResults);
  const rejectedText = rejected > 0 ? ` · ${rejected} rejected` : "";
  const checks = counts.total > 0 ? ` · checks: ${counts.passed} passed, ${counts.failed} failed` : "";
  if (failed > 0) {
    const actions = failed === 1 ? "1 action failed" : `${failed} actions failed`;
    return `Finished with errors · ${actions} · /activity${checks}${rejectedText}`;
  }
  if (result.status === "waiting_approval") return `Waiting for your decision · /pending${rejectedText}`;
  if (result.status !== "completed") return `Stopped · ${result.status.replace(/_/g, " ")}${checks}${rejectedText}`;
  const files = appliedFiles === 1 ? "1 file changed" : `${appliedFiles} files changed`;
  const checkText = counts.total > 0 ? `checks: ${counts.passed} passed, ${counts.failed} failed` : "no checks ran";
  return `Done · ${files} · ${checkText}${rejectedText}`;
};
