import type { AgentRunOutput } from "@zhivex-ai/agents";
import { formatVerificationSummary } from "../terminal/terminal-ui.js";

/** Conversation status never certifies tool success or test coverage. */
export const formatConsoleOutcome = (result: Pick<AgentRunOutput, "status" | "toolResults"> & {state?: Pick<AgentRunOutput["state"], "approvalHistory">},
  appliedFiles: number, denied: number) => {
  const rejections = result.state?.approvalHistory?.filter(item => !item.approve) ?? [];
  const rejectedCalls = new Set(rejections.flatMap(item => item.toolCallId ? [item.toolCallId] : []));
  const failed = result.toolResults.filter(item => item.isError && !rejectedCalls.has(item.toolCallId)).length;
  return [`Conversation: ${result.status === "completed" ? "completed" : result.status.replace(/_/g, " ")}`,
    `Actions: ${appliedFiles} file mutation receipts here · ${failed} other tool errors · ${Math.max(denied, rejections.length)} rejected decisions`,
    formatVerificationSummary(result.toolResults)].join("\n");
};
