import { ToolActivity, compactToolResult } from "./terminal/tool-activity.js";
import { USAGE_LEDGER_KEY, formatUsageLedger } from "../runtime/usage-ledger.js";
import { runResultDocument } from "./run-document.js";
import { TerminalMarkdown } from "./terminal/terminal-markdown.js";
import { sanitizeTerminalText, formatVerificationSummary } from "./terminal/terminal-ui.js";
import { createInterface } from "node:readline/promises";
import {
  createRedactionPolicy,
  type AgentApprovalRequest,
  type AgentApprovalResponse,
  type AgentRunOutput,
  type AgentStreamEvent
} from "@zhivex-ai/agents";
import { type HarnessRunOptions, type ZhivexHarness } from "../runtime/harness.js";
import { type AgentTelemetryObserver } from "@zhivex-ai/agents/ops";
import { serializeStreamEvent, serializeStreamResult } from "./cli-stream.js";
import {
  formatApproval,
  formatTerminalEvent,
  terminalRunFailure,
  resolveTerminalApprovals,
  terminalSupportsColor
} from "./terminal/terminal-ui.js";
import { normalizeHarnessError } from "../runtime/errors.js";
import { type CliOptions } from "./arguments.js";
import { resumeCommand } from "./resume-metadata.js";

const CLI_STREAM_ERROR_SEQUENCE = Symbol("cliStreamErrorSequence");

const terminalErrorRedaction = createRedactionPolicy({ includeEmails: true });

export const annotateCliStreamError = (error: unknown, lastSequence: number | undefined) => {
  const normalized = error instanceof Error ? error : normalizeHarnessError(error);
  Object.defineProperty(normalized, CLI_STREAM_ERROR_SEQUENCE, {
    configurable: true,
    enumerable: false,
    value: (lastSequence ?? 0) + 1
  });
  return normalized;
};

export const cliStreamErrorSequence = (error: unknown) =>
  error && typeof error === "object" &&
  Number.isSafeInteger((error as { [CLI_STREAM_ERROR_SEQUENCE]?: unknown })[CLI_STREAM_ERROR_SEQUENCE])
    ? (error as { [CLI_STREAM_ERROR_SEQUENCE]: number })[CLI_STREAM_ERROR_SEQUENCE]
    : 1;

export const terminalErrorMessage = (error: unknown) => terminalErrorRedaction.redactText(
  error instanceof Error ? error.message : String(error)
);

export const summarizeApproval = (approval: AgentApprovalRequest) => {
  return formatApproval(approval);
};

export const approvalResponses = (
  approvals: readonly AgentApprovalRequest[],
  approve: boolean,
  reason: string
): AgentApprovalResponse[] => approvals.map((approval) => ({
  provider: approval.provider,
  approvalRequestId: approval.id,
  approve,
  reason
}));

export const terminalApprovalResolver = (
  automaticallyApprove: boolean | "ask" | "auto" | "restricted",
  ask?: (question: string) => Promise<string>,
  ui?: { select: import("./cli-credentials.js").CredentialInput["select"]; workspace: string; sessionGrants?: Set<string> }
): NonNullable<HarnessRunOptions["resolveApprovals"]> => {
  return async (approvals) => {
    if (automaticallyApprove === "restricted") return approvalResponses(approvals, false, "Denied by restricted approval mode.");
    if (automaticallyApprove === true || automaticallyApprove === "auto") {
      return approvalResponses(approvals, true, "Approved by automatic mode.");
    }
    if (!ask && (!process.stdin.isTTY || !process.stdout.isTTY)) return undefined;
    const readline = ask ? undefined : createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await resolveTerminalApprovals(approvals, {
        ask: ask ?? ((text: string) => readline!.question(text)),
        write: text => process.stderr.write(text), ...ui
      });
    } finally {
      readline?.close();
    }
  };
};

export const printTerminalResult = (
  result: AgentRunOutput,
  harness: ZhivexHarness,
  output: Pick<CliOptions, "json" | "jsonl">,
  tracker: { streamedText: boolean; sequence?: number; markdown?: TerminalMarkdown }
) => {
  tracker.markdown?.flush();
  const document = runResultDocument(result, harness);
  if (output.jsonl) {
    tracker.sequence = (tracker.sequence ?? 0) + 1;
    process.stdout.write(`${serializeStreamResult(document, tracker.sequence)}\n`);
    return;
  }
  if (output.json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  if (!tracker.streamedText && result.outputText) {
    process.stdout.write(sanitizeTerminalText(result.outputText));
  }
  if (result.outputText || tracker.streamedText) {
    process.stdout.write("\n");
  }
  process.stderr.write(
    `\nrun ${result.state.runId} · ${result.state.provider}/${result.state.modelId} · ${result.status} · ${result.steps.length} steps · ${harness.workspace.mutationAudit().length} mutations\n`
  );
  if (result.state.metadata?.[USAGE_LEDGER_KEY]) process.stderr.write(formatUsageLedger(result.state.metadata[USAGE_LEDGER_KEY]) + "\n");
  process.stderr.write(formatVerificationSummary(result.toolResults) + "\n");
  if (result.status === "waiting_approval") {
    for (const approval of result.state.pendingApprovals) {
      process.stderr.write(`\nPending approval:\n${summarizeApproval(approval)}\n`);
    }
    process.stderr.write(
      `The state was persisted. Resume with: ${resumeCommand(result.state.runId, harness.config)}\n`
    );
  }
};

const proseLineOpen = new WeakSet<object>();
const conversationStarted = new WeakSet<object>();
const toolActivities = new WeakMap<object, ToolActivity>();
const lastTerminalFailures = new WeakMap<object, string>();
export const flushToolActivity = (tracker: object) => toolActivities.get(tracker)?.flush();

export const streamSink = (
  output: Pick<CliOptions, "json" | "jsonl">,
  tracker: { streamedText: boolean; sequence?: number; markdown?: TerminalMarkdown },
  compact = false
) => async (event: AgentStreamEvent) => {
  if (output.jsonl) {
    tracker.sequence = (tracker.sequence ?? 0) + 1;
    process.stdout.write(`${serializeStreamEvent(event, tracker.sequence)}\n`);
    return;
  }
  if (!output.json && compact && event.type === "agent-run-update") return;
  if (!output.json && compact) {
    let activity = toolActivities.get(tracker);
    if (!activity) {
      activity = new ToolActivity(text => { process.stderr.write(text); },
        Boolean(process.stderr.isTTY && process.stdout.isTTY), () => process.stderr.columns || 80);
      toolActivities.set(tracker, activity);
    }
    if (event.type === "agent-compaction") {
      tracker.markdown?.flush();
      if (proseLineOpen.has(tracker)) { process.stdout.write("\n"); proseLineOpen.delete(tracker); }
      activity.phase("Updating context");
      return;
    }
    if (event.type === "agent-step-start") {
      tracker.markdown?.flush();
      if (proseLineOpen.has(tracker)) { process.stdout.write("\n"); proseLineOpen.delete(tracker); }
      activity.phase("Waiting for model response", event.stepIndex);
      return;
    }
    if (event.type === "agent-run-start") {
      lastTerminalFailures.delete(tracker);
      activity.phase("Waiting for model response", event.currentStep);
      return;
    }
    if (event.type === "tool-call") {
      tracker.markdown?.flush();
      if (proseLineOpen.has(tracker)) { process.stdout.write("\n"); proseLineOpen.delete(tracker); }
      activity.start(event.toolCall.name);
      return;
    }
    if (event.type === "tool-result") {
      activity.finish(event.toolResult.toolName, !event.toolResult.isError);
      // Keep edits, checks and actionable failures explicit without fragmenting exploration.
      const detail = compactToolResult(event.toolResult);
      const check = ["run_check", "run_environment_command"].includes(event.toolResult.toolName) || event.toolResult.toolName.startsWith("verify_and_apply_");
      if (detail && !check) {
        activity.pause();
        tracker.markdown?.flush();
        if (proseLineOpen.has(tracker)) { process.stdout.write("\n"); proseLineOpen.delete(tracker); }
        process.stderr.write(`${detail}\n`);
        return;
      }
      if (!check) return;
      activity.pause();
    } else if (["agent-run-finish", "error", "tool-approval-request", "agent-approval-request"].includes(event.type)) {
      tracker.markdown?.flush();
      if (proseLineOpen.has(tracker)) { process.stdout.write("\n"); proseLineOpen.delete(tracker); }
      activity.flush();
    } else if (!["provider-data", "finish", "agent-step-start", "agent-step-finish"].includes(event.type)) {
      activity.pause();
    }
  }
  if (!output.json && event.type === "text-delta") {
    if (compact && !conversationStarted.has(tracker)) {
      process.stdout.write("\nZhivex\n"); conversationStarted.add(tracker);
    }
    if (event.textDelta.endsWith("\n")) proseLineOpen.delete(tracker);
    else if (event.textDelta) proseLineOpen.add(tracker);
    tracker.streamedText = true;
    if (process.stdout.isTTY) {
      tracker.markdown ??= new TerminalMarkdown((text) => { process.stdout.write(text); },
        terminalSupportsColor(true), () => process.stdout.columns || 80);
      tracker.markdown.write(event.textDelta);
    } else process.stdout.write(sanitizeTerminalText(event.textDelta));
    return;
  }
  if (!output.json) {
    if (compact && ["provider-data", "finish", "agent-run-start", "agent-step-start", "agent-step-finish", "tool-approval-request", "agent-approval-request", "agent-approval-resolved"].includes(event.type)) return;
    if (compact && event.type === "agent-run-finish" && event.status === "waiting_approval") return;
    tracker.markdown?.flush();
    proseLineOpen.delete(tracker);
    let line = formatTerminalEvent(event, {
      color: terminalSupportsColor(Boolean(process.stderr.isTTY))
    });
    if (compact && event.type === "tool-result" && event.toolResult.isError && line?.endsWith(" · error")) {
      line = compactToolResult(event.toolResult);
    }
    if ((event.type === "error" || (event.type === "agent-run-finish" && event.status === "failed")) && line) {
      const cause = terminalRunFailure(event.type === "error" ? event.error : event.state.error);
      if (lastTerminalFailures.get(tracker) === cause) return;
      lastTerminalFailures.set(tracker, cause);
    } else if (event.type === "agent-run-start") lastTerminalFailures.delete(tracker);
    if (line) process.stderr.write(`\n${line}\n`);
  }
};

export const orchestrationObserver = (json: boolean): AgentTelemetryObserver => async (event) => {
  if (json) return;
  if (event.type === "subagent-start") {
    process.stderr.write(`\nsubagent start · ${event.childAgentId ?? event.toolName}\n`);
  } else if (event.type === "subagent-finish") {
    process.stderr.write(
      `\nsubagent finish · ${event.childRun.agentId ?? event.childRun.toolName} · ${event.childRun.status}\n`
    );
  }
};
