import { expect, test } from "bun:test";
import { providerStreamFailureText } from "../src/provider-stream-failure.js";

test("renders the sanitized transport and parser reason without raw fields", () => {
  const diagnostic = { provider: "qwen", diagnosticCode: "QWEN_SSE_EVENT_INVALID", transport: "responses", reason: "invalid_json", retryable: false, message: "PRIVATE", payload: "PRIVATE" };
  expect(providerStreamFailureText(diagnostic)).toBe("The provider stream failed: QWEN_SSE_EVENT_INVALID (Responses, invalid JSON).");
  expect(providerStreamFailureText({ ...diagnostic, transport: "chat", reason: "invalid_event" })).toContain("Chat, invalid event shape");
  for (const extra of [{ provider: "PRIVATE" }, { reason: "PRIVATE" }, { transport: "PRIVATE" }, { diagnosticCode: "PRIVATE" }, { retryable: true }]) {
    expect(providerStreamFailureText({ ...diagnostic, ...extra })).toBeUndefined();
  }
  expect(providerStreamFailureText(null)).toBeUndefined();
});
