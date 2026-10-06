/** Render only the closed, sanitized host diagnostic; never stringify raw errors. */
export function providerStreamFailureText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const diagnostic = value as Record<string, unknown>;
  if (diagnostic.provider !== "qwen" || diagnostic.diagnosticCode !== "QWEN_SSE_EVENT_INVALID" ||
    diagnostic.retryable !== false ||
    (diagnostic.transport !== "chat" && diagnostic.transport !== "responses") ||
    (diagnostic.reason !== "invalid_json" && diagnostic.reason !== "invalid_event")) return;
  const transport = diagnostic.transport === "chat" ? "Chat" : "Responses";
  const reason = diagnostic.reason === "invalid_json" ? "invalid JSON" : "invalid event shape";
  return `The provider stream failed: QWEN_SSE_EVENT_INVALID (${transport}, ${reason}).`;
}
