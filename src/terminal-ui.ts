import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentStreamEvent
} from "@zhivex-ai/agents";

export const DEFAULT_APPROVAL_SUMMARY_CHARACTERS = 1_200;

const EXACT_REVIEW_TOOLS = new Set([
  "apply_patch",
  "apply_reviewed_edits",
  "verify_and_apply_reviewed_edits",
  "move_file",
  "quarantine_file",
  "restore_file",
  "run_check",
  "run_environment_command",
  "run_environment_batch",
  "run_environment_shell",
  "apply_environment_patch",
  "verify_and_apply_environment_patch"
]);

const TERMINAL_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

const escapeCodePoint = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).padStart(4, "0")}`
    : `\\u{${codePoint.toString(16)}}`;
};

/**
 * Make model- or provider-controlled text inert before writing it to a terminal.
 * Newlines and tabs remain readable; cursor controls, ANSI/OSC introducers, C1
 * controls, and bidirectional overrides are rendered as visible escapes.
 */
export const sanitizeTerminalText = (value: string) =>
  value.replace(TERMINAL_CONTROL_CHARACTERS, escapeCodePoint);

const readableApprovalArguments = (argumentsText: string) => {
  try {
    return sanitizeTerminalText(JSON.stringify(JSON.parse(argumentsText), null, 2));
  } catch {
    return sanitizeTerminalText(argumentsText);
  }
};

const boundedText = (value: string, maximumCharacters: number) => {
  if (value.length <= maximumCharacters) {
    return { text: value, omitted: 0 };
  }
  return {
    text: `${value.slice(0, maximumCharacters)}…`,
    omitted: value.length - maximumCharacters
  };
};

export interface ApprovalFormatOptions {
  detail?: "summary" | "full";
  maxSummaryCharacters?: number;
}

/**
 * Render an approval without trusting its provider-controlled labels or input.
 * Built-in mutation and execution tools retain their complete reviewed payload.
 * Unknown/provider tools get a bounded default card and an explicit full view.
 */
export const formatApproval = (
  approval: AgentApprovalRequest,
  options: ApprovalFormatOptions = {}
) => {
  const detail = options.detail ?? "summary";
  const maximumCharacters = options.maxSummaryCharacters ?? DEFAULT_APPROVAL_SUMMARY_CHARACTERS;
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new Error("Approval summary length must be a positive safe integer.");
  }

  const completePayload = readableApprovalArguments(approval.arguments);
  const shouldShowComplete = detail === "full" || EXACT_REVIEW_TOOLS.has(approval.name);
  const payload = shouldShowComplete
    ? { text: completePayload, omitted: 0 }
    : boundedText(completePayload, maximumCharacters);
  const identity = [
    approval.inputDigest ? `input ${sanitizeTerminalText(approval.inputDigest)}` : undefined,
    approval.serverLabel ? `server ${sanitizeTerminalText(approval.serverLabel)}` : undefined,
    approval.childAgentId ? `child ${sanitizeTerminalText(approval.childAgentId)}` : undefined
  ].filter((value): value is string => value !== undefined);
  const header = `[${sanitizeTerminalText(approval.kind ?? "provider")}] ` +
    `${sanitizeTerminalText(approval.name)}` +
    (identity.length > 0 ? ` · ${identity.join(" · ")}` : "");
  const omissionNotice = payload.omitted > 0
    ? `\n[${payload.omitted} characters omitted; press v to view the complete payload]`
    : "";
  return `${header}\n${payload.text}${omissionNotice}`;
};

export interface TerminalApprovalResolverOptions {
  ask(question: string): Promise<string>;
  write(text: string): void;
  maxSummaryCharacters?: number;
  approvedReason?: string;
  deniedReason?: string;
}

const promptEnded = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" ||
    candidate.code === "ABORT_ERR" ||
    candidate.code === "ERR_USE_AFTER_CLOSE";
};

const normalizedDecision = (answer: string) => answer.trim().toLowerCase();

/**
 * Resolve approvals one at a time. Returning undefined deliberately leaves the
 * complete durable approval batch pending; earlier answers are never returned
 * as a partial resolution when the operator quits or the prompt closes.
 */
export const resolveTerminalApprovals = async (
  approvals: readonly AgentApprovalRequest[],
  options: TerminalApprovalResolverOptions
): Promise<readonly AgentApprovalResponse[] | undefined> => {
  const responses: AgentApprovalResponse[] = [];
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = approvals[index]!;
    options.write(
      `\nApproval required ${index + 1}/${approvals.length}:\n` +
      `${formatApproval(approval, {
        detail: "summary",
        ...(options.maxSummaryCharacters !== undefined
          ? { maxSummaryCharacters: options.maxSummaryCharacters }
          : {})
      })}\n`
    );

    for (;;) {
      let answer: string;
      try {
        const received = await options.ask("Approve? [y]es/[n]o/[v]iew/[q]uit (default: no) ");
        if (typeof received !== "string") return undefined;
        answer = normalizedDecision(received);
      } catch (error) {
        if (promptEnded(error)) return undefined;
        throw error;
      }

      if (answer === "v" || answer === "view") {
        options.write(`\nComplete approval payload:\n${formatApproval(approval, { detail: "full" })}\n`);
        continue;
      }
      if (answer === "q" || answer === "quit") {
        return undefined;
      }
      if (answer === "y" || answer === "yes") {
        responses.push({
          provider: approval.provider,
          approvalRequestId: approval.id,
          approve: true,
          reason: options.approvedReason ?? "Approved interactively."
        });
        break;
      }
      if (answer === "" || answer === "n" || answer === "no") {
        responses.push({
          provider: approval.provider,
          approvalRequestId: approval.id,
          approve: false,
          reason: options.deniedReason ?? "Denied by the operator."
        });
        break;
      }
      options.write("Choose y, n, v, or q.\n");
    }
  }
  return responses;
};

export interface TerminalAppearanceOptions {
  color?: boolean;
}

export const terminalSupportsColor = (
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
) => isTTY &&
  !Object.prototype.hasOwnProperty.call(env, "NO_COLOR") &&
  env.TERM !== "dumb" &&
  env.FORCE_COLOR !== "0";

const paint = (text: string, code: number, color: boolean) =>
  color ? `\u001b[${code}m${text}\u001b[0m` : text;

/**
 * Produce a compact activity line from a redacted event subset. Tool inputs,
 * outputs, provider payloads, repository text, and raw errors are never read.
 */
export const formatTerminalEvent = (
  event: AgentStreamEvent,
  options: TerminalAppearanceOptions = {}
): string | undefined => {
  const color = options.color ?? false;
  switch (event.type) {
    case "text-delta":
      return undefined;
    case "tool-call":
      return `${paint("↳", 36, color)} tool · ${sanitizeTerminalText(event.toolCall.name)}`;
    case "tool-result":
      return event.toolResult.isError
        ? `${paint("✗", 31, color)} tool · ${sanitizeTerminalText(event.toolResult.toolName)} · error`
        : `${paint("✓", 32, color)} tool · ${sanitizeTerminalText(event.toolResult.toolName)}`;
    case "tool-approval-request":
    case "agent-approval-request":
      return `${paint("!", 33, color)} approval · ` +
        `${sanitizeTerminalText(event.approval.kind ?? "provider")} · ` +
        sanitizeTerminalText(event.approval.name);
    case "agent-approval-resolved":
      return event.approval.approve
        ? `${paint("✓", 32, color)} approval · approved`
        : `${paint("✗", 31, color)} approval · denied`;
    case "provider-data":
      return `${paint("·", 90, color)} provider · ${sanitizeTerminalText(event.provider)}`;
    case "image-generation":
      return `${paint("·", 36, color)} image · ${sanitizeTerminalText(event.provider)}` +
        (event.partial ? " · partial" : " · complete");
    case "finish":
      return `${paint("·", 90, color)} model stream` +
        (event.finishReason ? ` · ${sanitizeTerminalText(event.finishReason)}` : " · finished");
    case "error":
      return `${paint("✗", 31, color)} provider stream failed`;
    case "agent-run-start":
      return `${paint("●", 36, color)} run · step ${event.currentStep}/${event.maxSteps}`;
    case "agent-step-start":
      return `${paint("●", 36, color)} step ${event.stepIndex + 1}`;
    case "agent-step-finish":
      return `${paint(event.step.status === "failed" ? "✗" : "✓", event.step.status === "failed" ? 31 : 32, color)} ` +
        `step ${event.step.index + 1} · ${sanitizeTerminalText(event.step.status)} · ` +
        `${event.step.toolResults.length} tool${event.step.toolResults.length === 1 ? "" : "s"}`;
    case "agent-compaction":
      return `${paint("↺", 36, color)} context · ${event.compaction.messageCountBefore} → ` +
        `${event.compaction.messageCountAfter} messages`;
    case "agent-run-finish":
      return `${paint(event.status === "completed" ? "✓" : "●", event.status === "completed" ? 32 : 33, color)} ` +
        `run · ${sanitizeTerminalText(event.status)} · ` +
        `${sanitizeTerminalText(event.state.provider)}/${sanitizeTerminalText(event.state.modelId)}`;
  }
};

export interface TerminalHeaderInput {
  version: string;
  provider: string;
  model: string;
  sessionId: string;
  sessionTitle?: string;
}

export const formatTerminalHeader = (
  input: TerminalHeaderInput,
  options: TerminalAppearanceOptions = {}
) => {
  const color = options.color ?? false;
  const title = input.sessionTitle
    ? ` · ${sanitizeTerminalText(input.sessionTitle)}`
    : "";
  return `${paint(`Zhivex Harness ${sanitizeTerminalText(input.version)}`, 36, color)} · ` +
    `${sanitizeTerminalText(input.provider)}/${sanitizeTerminalText(input.model)}\n` +
    `session ${sanitizeTerminalText(input.sessionId)}${title}`;
};
