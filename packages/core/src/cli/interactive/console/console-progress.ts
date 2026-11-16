import { createHash } from "node:crypto";
import type { AgentStreamEvent } from "@zhivex-ai/agents";

/** A local-session circuit breaker. Do not retain tool payloads or replay tools. */
export function consoleProgressGuard() {
  const controller = new AbortController();
  const calls = new Map<string, string>();
  let previous = "", repeated = 0;
  return {
    signal: controller.signal,
    observe(event: AgentStreamEvent) {
      if (event.type === "tool-call") {
        const { id, ...request } = event.toolCall;
        calls.set(id, createHash("sha256").update(JSON.stringify(request)).digest("hex"));
      }
      if (event.type !== "tool-result") return;
      const key = calls.get(event.toolResult.toolCallId);
      calls.delete(event.toolResult.toolCallId);
      if (!event.toolResult.isError || !key) { previous = ""; repeated = 0; return; }
      repeated = key === previous ? repeated + 1 : 1;
      previous = key;
      if (repeated === 3) controller.abort(new Error("Repeated identical tool failures. Inspect /status and correct the cause before /continue."));
    }
  };
}
