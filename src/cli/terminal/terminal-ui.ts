import { checkApprovalGrant } from "./session-grants.js";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentStreamEvent
} from "@zhivex-ai/agents";

export const DEFAULT_APPROVAL_SUMMARY_CHARACTERS = 1_200;

const EXACT_REVIEW_TOOLS = new Set([
  "apply_patch",
  "apply_reviewed_edits",
  "apply_reviewed_replacement",
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
    detail === "full" && approval.id ? `approval ${sanitizeTerminalText(approval.id)}` : undefined,
    detail === "full" && approval.inputDigest ? `input ${sanitizeTerminalText(approval.inputDigest)}` : undefined,
    approval.serverLabel ? `server ${sanitizeTerminalText(approval.serverLabel)}` : undefined,
    approval.childAgentId ? `child ${sanitizeTerminalText(approval.childAgentId)}` : undefined
  ].filter((value): value is string => value !== undefined);
  const header = `[${sanitizeTerminalText(approval.kind ?? "provider")}] ` +
    `${sanitizeTerminalText(approval.name)}` +
    (identity.length > 0 ? ` · ${identity.join(" · ")}` : "");
  const omissionNotice = payload.omitted > 0
    ? `\n[${payload.omitted} characters omitted; press v to view the complete payload]`
    : "";
  const scope: string[] = [];
  if (EXACT_REVIEW_TOOLS.has(approval.name)) {
    try {
      const args = JSON.parse(approval.arguments);
      if (Array.isArray(args.changes)) for (const change of args.changes) {
        if (typeof change?.path === "string") scope.push(`${change.expectedDigest === null ? "ADD" : "MODIFY"} ${change.path}`);
      }
      if (approval.name === "quarantine_file" && typeof args.path === "string") scope.push(`REMOVE (recoverable quarantine) ${args.path}`);
      if (approval.name === "move_file") scope.push(`MOVE ${args.source} -> ${args.destination}`);
      if (approval.name.includes("verify_and_apply")) scope.push("Verification: pending; approval authorizes the checks and conditional application, not a successful result.");
    } catch { /* The complete unparseable payload remains visible below. */ }
  }
  if (detail === "summary" && approval.kind === "local-tool" && approval.name === "run_check") {
    try {
      const args = JSON.parse(approval.arguments);
      if (typeof args.check === "string" && typeof args.expectedScript === "string" &&
          Object.keys(args).every(key => ["check", "expectedScript"].includes(key))) {
        return `Run check: ${sanitizeTerminalText(args.check)}${identity.length ? ` · ${identity.join(" · ")}` : ""}\n\n  ${sanitizeTerminalText(args.expectedScript)}\n`;
      }
    } catch { /* Keep the complete original payload visible below. */ }
  }
  return `${header}\n${scope.map(sanitizeTerminalText).map(line => `${line}\n`).join("")}${payload.text}${omissionNotice}`;
};

export interface TerminalApprovalResolverOptions {
  ask(question: string): Promise<string>;
  select?: import("../cli-credentials.js").CredentialInput["select"];
  workspace?: string;
  sessionGrants?: Set<string>;
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
  const staged = new Set(options.sessionGrants);
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = approvals[index]!;
    const grant = options.sessionGrants && options.workspace ? checkApprovalGrant(approval, options.workspace) : undefined;
    if (grant && staged.has(grant)) {
      responses.push({ provider: approval.provider, approvalRequestId: approval.id, approve: true, reason: "Exact check approved for this CLI session." });
      continue;
    }
    options.write(
      `\nApproval required ${index + 1}/${approvals.length}:\n` +
      `${formatApproval(approval, {
        detail: "summary",
        ...(options.maxSummaryCharacters !== undefined
          ? { maxSummaryCharacters: options.maxSummaryCharacters }
          : {})
      })}\n`
    );

    if (options.workspace) options.write(`Workspace: ${sanitizeTerminalText(options.workspace)}\n`);
    for (;;) {
      let answer: string;
      try {
        const received = options.select ? await options.select("Permission required", [
          { value: "n", label: "Reject" },
          { value: "y", label: "Allow once", detail: "Only the action shown above" },
          ...(grant ? [{ value: "s", label: "Allow this exact check for this session", detail: "Changing the script requires approval again" }] : []),
          { value: "v", label: "View technical details" },
          { value: "q", label: "Leave pending" },
        ]) : await options.ask(`Approve? [y]es/${grant ? "[s]ession/" : ""}[n]o/[v]iew/[q]uit (default: no) `);
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
      if (answer === "y" || answer === "yes" || (answer === "s" && grant)) {
        if (answer === "s" && grant) staged.add(grant);
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
  for (const key of staged) options.sessionGrants?.add(key);
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

const verificationReceipt = (name: string, output: unknown) => {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Record<string, unknown>;
  const receipt = name === "run_check" || name === "run_environment_command" ? value
    : name.startsWith("verify_and_apply_") && value.verification && typeof value.verification === "object"
      ? value.verification as Record<string, unknown> : undefined;
  if (!receipt || !Number.isSafeInteger(receipt.exitCode)) return undefined;
  const command = receipt.command;
  const prefix = Array.isArray(command) ? JSON.stringify(command.slice(0, -1)) : "";
  const supported = ['["bun","--no-env-file","run"]', '["npm","--ignore-scripts","run"]',
    '["pnpm","--ignore-scripts","run"]', '["yarn","run"]'];
  const last = Array.isArray(command) ? command.at(-1) : undefined;
  const check = name === "run_check" && supported.includes(prefix) &&
    typeof last === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(last) ? last : undefined;
  return { exitCode: receipt.exitCode as number, timedOut: receipt.timedOut === true, check };
};

export const formatVerificationSummary = (results: readonly { toolName: string; output?: unknown; isError?: boolean }[]) => {
  const receipts = results.flatMap(result => {
    const receipt = verificationReceipt(result.toolName, result.output);
    return receipt ? [{ ...receipt, failed: Boolean(result.isError) || receipt.timedOut || receipt.exitCode !== 0 }] : [];
  });
  if (!receipts.length) return "Verification: no check receipts recorded; completion does not certify checks.";
  const failed = receipts.filter(receipt => receipt.failed).length;
  return `Verification receipts: ${receipts.length - failed} passed, ${failed} failed/timed out. Only recorded commands are covered.`;
};

const paint = (text: string, code: number, color: boolean) =>
  color ? `\u001b[${code}m${text}\u001b[0m` : text;

/**
 * Produce a compact activity line from a redacted event subset. Tool inputs,
 * outputs, provider payloads, repository text, and raw errors are never read.
 */
/** Only known runtime diagnostics are projected; provider payloads remain private. */
export const terminalRunFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : "";
  const provider = /^(Meta|Qwen|OpenAI|Gemini) request failed with status ([45]\d{2})(?: \((previous response unavailable|context length exceeded|tools rejected|input rejected|output token limit rejected|previous response rejected|reason unavailable)\))?\.$/.exec(message);
  if (provider) return `${provider[1]} request failed · HTTP ${provider[2]}${provider[3] ? ` · ${provider[3]}` : ""}`;
  const budget = /^Agent budget exceeded including child runs: (maxInputTokens|maxOutputTokens|maxTotalTokens|maxToolCalls|maxToolErrors|maxSteps) limit (\d+), actual (\d+)\.$/.exec(message);
  if (budget) return `budget exceeded · ${budget[1]} · ${budget[3]} / ${budget[2]}`;
  const denied = /^Tool "(read_file|read_files|list_files|search_files|search_many)" failed: The path is protected by the harness policy: (node_modules|\.git|\.zhivex-harness|dist|coverage|\.next|\.turbo)$/.exec(message);
  if (denied) return `read denied · protected path ${denied[2]}`;
  if (message === "Agent compaction result still exceeds maxEstimatedInputTokens." ||
      message === "Agent compaction cannot satisfy its limits without removing protected messages.") {
    return "context could not fit after compaction · retained messages exceed the input limit";
  }
  const streamOverflow = /^Stream replay buffer exceeded its limit of (\d+) events\.$/.exec(message);
  if (streamOverflow) return `event replay limit reached · ${streamOverflow[1]} events`;
  if (/^Tool is not registered \(sha256:[a-f0-9]{64}\)\.$/.test(message)) {
    return "requested tool is not registered · use an available tool with its exact name";
  }
  const cap = /^(maxInputTokens|maxOutputTokens|maxTotalTokens) budget (exceeded|exhausted)$/.exec(message);
  if (cap) return `budget ${cap[2]} · ${cap[1]}`;
  if (message === "Agent exhausted maxSteps before reaching a terminal response.") {
    return "step limit reached before a final response";
  }
  return "run failed · cause unavailable (inspect run diagnostics)";
};

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
    case "tool-result": {
      const receipt = verificationReceipt(event.toolResult.toolName, event.toolResult.output);
      if (receipt) {
        const failed = event.toolResult.isError || receipt.timedOut || receipt.exitCode !== 0;
        return `${paint(failed ? "✗" : "✓", failed ? 31 : 32, color)} check · ${receipt.check ?? sanitizeTerminalText(event.toolResult.toolName)} · exit ${receipt.exitCode}${receipt.timedOut ? " · timed out" : ""}`;
      }
      return event.toolResult.isError
        ? `${paint("✗", 31, color)} tool · ${sanitizeTerminalText(event.toolResult.toolName)} · error`
        : `${paint("✓", 32, color)} tool · ${sanitizeTerminalText(event.toolResult.toolName)}`;
    }
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
      return `${paint("✗", 31, color)} ${terminalRunFailure(event.error)}`;
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
      if (event.status === "failed") {
        const cause = terminalRunFailure(event.state.error);
        return `${paint("✗", 31, color)} ${cause}` +
          (cause === "step limit reached before a final response"
            ? ` (${event.state.currentStep}/${event.state.maxSteps}). Session retained; use /limits to adjust the next turn, then ask to continue.` : "");
      }
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
