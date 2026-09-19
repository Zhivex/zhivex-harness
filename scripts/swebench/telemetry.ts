import type { AgentRunState, AgentStep } from "@zhivex-ai/agents";
import { createHash } from "node:crypto";
import { normalizeHarnessError } from "../../src/errors.js";
const knownTools = new Set(["read_task", "repair_plan", "mutation_audit", "list_files", "read_file", "read_files", "search_files", "search_many", "apply_reviewed_replacement", "apply_reviewed_edits", "run_environment_shell", "run_environment_command", "run_environment_batch", "inspect_environment_patch", "verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits", "run_check", "git_diff", "propose_edits", "apply_patch", "load_skill"]);
const safeToolName = (name: string) => knownTools.has(name) ? name : "other-tool";
export const sanitizeOperationalError = (error: unknown) => {
  const normalized = normalizeHarnessError(error);
  const chain: { validationCode: "TOOL_INPUT_VALIDATION_ERROR" | null; fingerprint: string; reason: string | null; providerReason: string | null; validationIssues: { code: string; path: (string | number)[] }[]; status: number | null; errorClass: string | null; providerHints: string[] }[] = [];
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const value = current as { message?: unknown; cause?: unknown; reason?: unknown; status?: unknown; statusCode?: unknown; constructor?: { name?: string }; responseBody?: unknown };
    const text = typeof value.message === "string" ? value.message : "";
    const reason = ["lease", "snapshot", "permission", "timeout", "budget", "symlink", "output limit", "tool call", "read-only", "invalid input", "not registered", "cannot satisfy", "compaction", "must be", "enoent", "no such file", "not a directory", "is a directory", "invalid line range", "protected", "not unique", "no tool output", "previous_response_id", "function_call", "invalid_request_error", "context_length_exceeded", "rate limit", "unauthorized", "tool_calls", "tool call id", "undeclared", "not allowlisted"].find((key) => text.toLowerCase().includes(key)) ?? null;
    const providerReason = typeof value.reason === "string" && ["empty_arguments", "invalid_json", "arguments_too_large", "incomplete_arguments", "inconsistent_metadata", "response_failed", "response_incomplete", "stream_truncated"].includes(value.reason) ? value.reason : null;
    const validationIssues: { code: string; path: (string | number)[] }[] = [];
    const structured = current as { code?: unknown; issues?: unknown };
    const schemaError = structured.code === "TOOL_INPUT_VALIDATION_ERROR";
    if (schemaError || (text.startsWith("Invalid input for tool ") && text.includes(": [")) || text.startsWith("[")) {
      try {
        const issues = schemaError ? structured.issues : JSON.parse(text.startsWith("[") ? text : text.slice(text.indexOf(": [") + 2));
        for (const issue of (Array.isArray(issues) ? issues.slice(0, 32) : [])) {
          if (["invalid_type", "too_small", "too_big", "invalid_value", "unrecognized_keys", "custom"].includes(issue.code)) {
            validationIssues.push({ code: issue.code, path: (issue.path ?? []).map((part: unknown) => typeof part === "number" ? part :
              ["files", "path", "startLine", "endLine", "queries", "query", "caseSensitive", "limitPerQuery", "expectedDigest", "oldText", "newText", "changes", "content", "cursor", "limit", "includeDigests"].includes(String(part)) ? String(part) : "field") });
          }
        }
      } catch { /* No raw fallback. */ }
    }
    const rawStatus = value.status ?? value.statusCode;
    const status = typeof rawStatus === "number" && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
    const name = (current as { name?: string }).name ?? value.constructor?.name;
    const errorClass = name && ["ZodError", "AgentPolicyTimeoutError", "ConfigurationError", "FileChangedWhileReadingError", "FileSizeLimitError", "GuardrailTriggeredError", "StreamBufferOverflowError", "ToolExecutionSuspendedError", "ToolExecutionTimeoutError", "UnsafeFileTypeError", "UnsupportedFeatureError", "ProviderResponseTooLargeError", "ProviderHTTPError", "ValidationError", "ConflictError", "TypeError", "HarnessExecutionError", "HarnessWorkspaceError", "ProviderToolCallError", "ParseError", "SyntaxError", "AbortError", "TimeoutError", "Error", "Object"].includes(name) ? name : null;
    const body = typeof value.responseBody === "string" ? value.responseBody.toLowerCase() : "";
    const providerHints = ["reasoning", "encrypted", "following", "preceding", "without", "required", "function_call", "function_call_output", "no tool output", "not found", "invalid", "duplicate", "message", "assistant", "input", "signature", "store", "unsupported", "too long"].filter((hint) => body.includes(hint));
    chain.push({ validationCode: schemaError ? "TOOL_INPUT_VALIDATION_ERROR" : null, providerReason, validationIssues, status, errorClass, providerHints, fingerprint: createHash("sha256").update(text).digest("hex"), reason });
    current = value.cause;
  }
  const failureType = chain.some(c => c.validationCode) ? "schema" : chain.some(c => c.reason === "budget") ? "budget"
    : chain.some(c => c.errorClass === "AbortError") ? "cancelled" : chain.some(c => c.reason === "timeout" || c.errorClass === "TimeoutError") ? "timeout"
    : chain.some(c => c.errorClass === "ParseError" || c.errorClass === "SyntaxError" || c.providerReason) ? "parsing"
    : chain.some(c => c.status !== null) ? "transport" : chain.some(c => c.reason === "permission" || c.reason === "protected") ? "policy" : "execution";
  return { code: normalized.code, category: normalized.category, failureType, retryable: normalized.retryable, chain };
};

const commandOutcome = (name: string, value: unknown) => {
  if (!["run_environment_command", "run_environment_batch", "run_environment_shell", "verify_and_apply_environment_patch", "run_check"].includes(name)) return {};
  if (!value || typeof value !== "object") return {};
  const outer = value as Record<string, unknown>;
  const data = outer.verification && typeof outer.verification === "object" ? outer.verification as Record<string, unknown> : outer;
  const phases = data.phaseLatencies && typeof data.phaseLatencies === "object" ? Object.fromEntries(Object.entries(data.phaseLatencies).filter(([key, value]) =>
    ["hostSynchronizationMs", "sessionCreationMs", "commandAndAttestationMs", "workspaceExportMs", "totalMs"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)) : undefined;
  return { ...(phases ? { phaseLatencies: phases } : {}), ...(Number.isSafeInteger(data.exitCode) ? { exitCode: data.exitCode } : {}),
    ...(typeof data.timedOut === "boolean" ? { timedOut: data.timedOut } : {}),
    ...(typeof data.cancelled === "boolean" ? { cancelled: data.cancelled } : {}),
    ...(typeof data.outputLimitExceeded === "boolean" ? { outputLimitExceeded: data.outputLimitExceeded } : {}),
    ...(name.startsWith("verify_") && Number.isSafeInteger(data.exitCode) ? { verificationOutcome: data.exitCode === 0 && !data.timedOut && !data.cancelled && !data.outputLimitExceeded ? "passed" : "failed" } : {}) };
};

export const projectStep = (step: AgentStep) => ({
  index: step.index, status: step.status,
  finishReason: step.response?.finishReason ?? null,
  requestedTools: (step.response?.messages ?? []).flatMap(message => message.parts.flatMap(part => part.type === "tool-call" ? [safeToolName(part.toolCall.name)] : [])).slice(0, 64),
  inputTokens: step.response?.usage?.inputTokens ?? null,
  outputTokens: step.response?.usage?.outputTokens ?? null,
  cachedInputTokens: step.response?.usage?.cachedInputTokens ?? 0,
  requestCharacters: JSON.stringify(step.request.messages).length,
  tools: step.toolResults.map((result) => ({
    name: safeToolName(result.toolName), isError: result.isError,
    characters: JSON.stringify(result.output ?? null).length,
    ...commandOutcome(result.toolName, result.output),
    ...(result.error ? { diagnostic: sanitizeOperationalError(result.error) } : {})
  })),
  ...(step.error ? { diagnostic: sanitizeOperationalError(step.error) } : {})
});

export const projectState = (state: AgentRunState | undefined, observed: Map<number, AgentStep>) => {
  const steps = new Map(observed);
  for (const step of state?.steps ?? []) steps.set(step.index, step);
  const turns = [...steps.values()].sort((a, b) => a.index - b.index).map(projectStep);
  return {
    turns,
    inputTokens: turns.reduce((sum, step) => sum + (step.inputTokens ?? 0), 0),
    outputTokens: turns.reduce((sum, step) => sum + (step.outputTokens ?? 0), 0),
    cachedInputTokens: turns.reduce((sum, step) => sum + step.cachedInputTokens, 0),
    modelCalls: turns.filter((step) => step.inputTokens !== null).length,
    usageComplete: turns.length > 0 && turns.every((step) => step.inputTokens !== null && step.outputTokens !== null),
    compactions: (state?.compactions ?? []).map((c) => ({ beforeStep: c.beforeStep,
      estimatedTokensBefore: c.estimatedTokensBefore, estimatedTokensAfter: c.estimatedTokensAfter })),
    terminalDiagnostic: state?.error ? sanitizeOperationalError(state.error) : null
  };
};
