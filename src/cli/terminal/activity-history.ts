import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import type { MutationAuditEntry } from "../../workspace/edit-contracts.js";
import { sanitizeTerminalText } from "./terminal-ui.js";
import { compactToolResult } from "./tool-activity.js";

const redaction = createRedactionPolicy({ includeEmails: true });
const toolNames = new Set(["read_file", "read_files", "read_dependency", "search_files", "search_many", "list_files", "git_diff", "run_check", "run_environment_command", "propose_edits", "apply_patch", "apply_reviewed_edits", "apply_reviewed_replacement", "apply_environment_patch", "verify_and_apply_patch", "verify_and_apply_replacement", "move_file", "quarantine_file", "restore_file"]);
const safeName = (name: string) => toolNames.has(name) ? name : "tool";
const safePath = (path: string) => redaction.redactText(sanitizeTerminalText(path)).replace(/[\r\n\t]/g, " ").slice(0, 240);

/** Bounded in-memory activity, not model reasoning or raw tool payloads. */
export class ActivityHistory {
  private lines: string[] = [];
  private started = Date.now();
  private dropped = 0;
  clear() { this.lines = []; this.dropped = 0; this.started = Date.now(); }
  add(text: string) {
    this.lines.push(`[${((Date.now() - this.started) / 1000).toFixed(1)}s] ${text.slice(0, 800)}`);
    if (this.lines.length > 200) { this.lines.shift(); this.dropped++; }
  }
  observe(event: AgentStreamEvent) {
    if (event.type === "agent-run-start") this.add("Run started / resumed");
    else if (event.type === "agent-step-start") this.add("Waiting for model response");
    else if (event.type === "agent-compaction") this.add("Updating context");
    else if (event.type === "tool-call") this.add(`Preparing ${safeName(event.toolCall.name)}`);
    else if (event.type === "tool-result") this.add(compactToolResult(event.toolResult) ?? `${event.toolResult.isError ? "Failed" : "Finished"} ${safeName(event.toolResult.toolName)}`);
    else if (event.type === "tool-approval-request") this.add(`Waiting for approval: ${safeName(event.approval.name)}`);
    else if (event.type === "agent-approval-resolved") this.add(event.approval.approve ? "Approval granted" : "Approval denied");
    else if (event.type === "agent-run-finish") this.add(`Run ${event.status}`);
  }
  observeService(event: Record<string, unknown>) {
    const name = typeof event.toolName === "string" ? safeName(event.toolName) : "tool";
    if (event.type === "tool-call") this.add(`Preparing ${name}`);
    else if (event.type === "tool-result") this.add(`${event.isError ? "Failed" : "Finished"} ${name}`);
    else if (event.type === "tool-approval-request") this.add(`Waiting for approval: ${name}`);
    else if (event.type === "agent-step-start") this.add("Waiting for model response");
    else if (event.type === "agent-compaction") this.add("Updating context");
    else if (event.type === "agent-run-start") this.add("Run started / resumed");
    else if (event.type === "agent-run-finish") this.add("Run stopped; inspect /status for outcome");
  }
  render() {
    return this.lines.length ? `Activity history · this console session${this.dropped ? ` · ${this.dropped} earlier entries omitted` : ""}\n${this.lines.join("\n")}\n` : "No activity recorded in this console session.\n";
  }
}

/** Only workspace-owned committed mutation receipts may supply file labels. */
export const formatAppliedFiles = (entries: readonly Pick<MutationAuditEntry, "operation" | "path" | "destination">[], reviewHint = "/diff to review"): string => {
  if (!entries.length) return "";
  const lines = entries.slice(0, 20).map(entry => `  ${entry.operation} ${safePath(entry.path)}${entry.destination ? ` → ${safePath(entry.destination)}` : ""}`);
  if (entries.length > 20) lines.push(`  … ${entries.length - 20} more files`);
  return `✓ Applied ${entries.length} file change${entries.length === 1 ? "" : "s"}\n${lines.join("\n")}\n  ${reviewHint} · verification reported separately\n`;
};
