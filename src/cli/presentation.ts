import { ToolActivity } from "./terminal/tool-activity.js";
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
  const grants = new Set<string>();
  return async (approvals) => {
  if (automaticallyApprove === "restricted") return approvalResponses(approvals, false, "Denied by restricted approval mode.");
  if ((automaticallyApprove === true || automaticallyApprove === "auto") && !approvals.some(a => a.name === "read_dependency")) {
    return approvalResponses(approvals, true, "Approved by --yes.");
  }
  if (!ask && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return undefined;
  }

  const readline = ask ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const question = ask ?? ((text: string) => readline!.question(text));
  try {
    if (!approvals.some(a => a.name === "read_dependency")) {
      return await resolveTerminalApprovals(approvals, { ask: question, write: text => process.stderr.write(text), ...ui });
    }
    const responses: AgentApprovalResponse[] = [];
    const staged = new Set(grants);
    const stagedSession = ui?.sessionGrants ? new Set(ui.sessionGrants) : undefined;
    for (const approval of approvals) {
      if (approval.name === "read_dependency") {
        let name: string | undefined;
        try {
          const args = typeof approval.arguments === "string" ? JSON.parse(approval.arguments) : approval.arguments;
          if (args && typeof args.package === "string" && /^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(args.package)) name = args.package;
        } catch { /* Malformed requests never gain a grant. */ }
        const key = name ? JSON.stringify([approval.provider, approval.childAgentId ?? "", name]) : undefined;
        const sessionKey = key && ui?.workspace ? JSON.stringify(["dependency", ui.workspace, key]) : undefined;
        if (sessionKey && stagedSession?.has(sessionKey)) { responses.push(...approvalResponses([approval], true, "Dependency metadata/types approved for this CLI session.")); continue; }
        if (key && staged.has(key)) { responses.push(...approvalResponses([approval], true, "Dependency read approved for this task.")); continue; }
        process.stderr.write(formatApproval(approval, { detail: "summary" }) + "\n");
        const answer = ui ? await ui.select(`Dependency metadata/types: ${name ?? "invalid package"}`, [
          { value: "n", label: "Reject" }, { value: "y", label: "Allow once" },
          { value: "t", label: "Allow this package for this task", detail: "Metadata and type declarations only" },
          ...(stagedSession ? [{ value: "s", label: "Allow this package for this session", detail: "Metadata and type declarations only" }] : []),
          { value: "q", label: "Leave pending" },
        ]) ?? "q" : (await question(`Read dependency ${name ?? "(invalid package)"} metadata/types? [y] once / [t] this task / [n] deny / [q] leave pending: `)).trim().toLowerCase();
        if (answer === "q") return undefined;
        const approved = Boolean(key && (["y", "yes", "t"].includes(answer) || (answer === "s" && stagedSession && sessionKey)));
        if (approved && answer === "t") staged.add(key!);
        if (approved && answer === "s" && sessionKey) stagedSession?.add(sessionKey);
        responses.push(...approvalResponses([approval], approved, approved ? "Approved bounded dependency read." : "Dependency read denied."));
      } else if (automaticallyApprove === true || automaticallyApprove === "auto") {
        responses.push(...approvalResponses([approval], true, "Approved by automatic mode."));
      } else {
        const result = await resolveTerminalApprovals([approval], { ask: question, write: text => process.stderr.write(text), ...ui, ...(stagedSession ? { sessionGrants: stagedSession } : {}) });
        if (!result) return undefined;
        responses.push(...result);
      }
    }
    for (const key of staged) grants.add(key);
    for (const key of stagedSession ?? []) ui?.sessionGrants?.add(key);
    return responses;
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
      // Checks and failures remain explicit, including nonzero check receipts.
      if (!event.toolResult.isError && !["run_check", "run_environment_command"].includes(event.toolResult.toolName) && !event.toolResult.toolName.startsWith("verify_and_apply_")) return;
      activity.flush();
    } else if (!["provider-data", "finish", "agent-step-start", "agent-step-finish"].includes(event.type)) {
      activity.flush();
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
    const line = formatTerminalEvent(event, {
      color: terminalSupportsColor(Boolean(process.stderr.isTTY))
    });
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
