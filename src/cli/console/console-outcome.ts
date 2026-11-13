import type { AgentRunOutput } from "@zhivex-ai/agents";
import { verificationCounts } from "../terminal/terminal-ui.js";

/** One honest line. Errors and rejections stay visible. Checks are named only when receipts exist. */
export const formatConsoleOutcome = (result: Pick<AgentRunOutput, "status" | "toolResults"> & {state?: Pick<AgentRunOutput["state"], "approvalHistory">},
  appliedFiles: number, denied: number, diff?: { added: number; removed: number }) => {
  const rejections = result.state?.approvalHistory?.filter(item => !item.approve) ?? [];
  const rejectedCalls = new Set(rejections.flatMap(item => item.toolCallId ? [item.toolCallId] : []));
  const failed = result.toolResults.filter(item => item.isError && !rejectedCalls.has(item.toolCallId)).length;
  const rejected = Math.max(denied, rejections.length);
  const counts = verificationCounts(result.toolResults);
  const rejectedText = rejected > 0 ? ` · ${rejected} rejected` : "";
  const checks = counts.total > 0 ? ` · checks: ${counts.passed} passed, ${counts.failed} failed` : "";
  const net = ` · net +${diff?.added ?? 0} −${diff?.removed ?? 0}`;
  const files = appliedFiles === 1 ? "1 file changed" : `${appliedFiles} files changed`;
  const checkText = counts.total > 0 ? `checks: ${counts.passed} passed, ${counts.failed} failed` : "no checks ran";
  if (failed > 0) {
    const actions = failed === 1 ? "1 action failed" : `${failed} actions failed`;
    return `Finished with errors · ${actions} · ${files}${net} · ${checkText} · /activity${rejectedText}`;
  }
  if (result.status === "waiting_approval") return `Waiting for your decision · /pending${net}${rejectedText}`;
  if (result.status !== "completed") return `Stopped · ${result.status.replace(/_/g, " ")}${net}${checks}${rejectedText}`;
  return `Done · ${files}${net} · ${checkText}${rejectedText}`;
};

/** Visual break between turns: a rule, the summary, and a blank line before the next task. */
export const formatTurnBanner = (summary: string) => `\n${"─".repeat(32)}\n${summary}\n\n`;
