import { expect, test } from "bun:test";
import { createQwen } from "@zhivex-ai/qwen";
import { classifyTimeToSafeFixFailure, timeToSafeFixDriverResultSchema } from "../src/runtime/time-to-safe-fix.js";
import { HarnessExecutionError } from "../src/runtime/errors.js";
import { sanitizeOperationalError, restoreSanitizedOperationalError } from "../scripts/release-diagnostics.js";

const sentinel = "PRIVATE_PROVIDER_PAYLOAD";
for (const mode of ["responses", "chat"] as const) {
  for (const scenario of ["valid", "invalid-arguments", "invalid-sse", "mixed-batch"] as const) {
    if (scenario === "mixed-batch" && mode === "chat") continue;
    test(`published Qwen ${mode}: ${scenario} retains safe diagnostics`, async () => {
      const args = scenario === "invalid-arguments" ? `{"${sentinel}":` : '{"path":"fixture.txt"}';
      const calls = (index: number, argumentsText: string) => [
        { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "read_file", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: index, item_id: `fc_${index}`, delta: argumentsText },
        { type: "response.function_call_arguments.done", output_index: index, item_id: `fc_${index}`, arguments: argumentsText }
      ];
      const events = mode === "responses" ? [
        ...calls(0, args),
        ...(scenario === "mixed-batch" ? calls(1, `{"${sentinel}":`) : []),
        { type: "response.completed", response: { id: "resp_fixture", status: "completed" } }
      ] : [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "read_file", arguments: args } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ];
      const body = scenario === "invalid-sse" ? `data: {${sentinel}\n\n` : events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      const fetcher = Object.assign(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }), { preconnect: () => {} }) as typeof fetch;
      const model = createQwen({ apiKey: "offline-fixture", fetch: fetcher })("qwen3.8-flash");
      const emitted: string[] = [];
      let error: unknown;
      try {
        for await (const event of await model.stream!({ messages: [{ role: "user", parts: [{ type: "text", text: "Read fixture" }] }], providerOptions: { apiMode: mode } })) emitted.push(event.type);
      } catch (caught) { error = caught; }
      if (scenario === "valid") {
        expect(error).toBeUndefined();
        expect(emitted).toContain("tool-call");
        expect(emitted).toContain("finish");
        return;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect(emitted).not.toContain("tool-call");
      const diagnosticCode = scenario === "invalid-sse" ? "QWEN_SSE_EVENT_INVALID" : mode === "responses" ? "QWEN_RESPONSES_TOOL_CALL_INVALID" : "QWEN_CHAT_TOOL_CALL_INVALID";
      const wrapped = new HarnessExecutionError("Harness execution failed.", { cause: error });
      const failure = classifyTimeToSafeFixFailure(wrapped, { stage: "model", origin: "agent_run" });
      expect(failure).toMatchObject({ code: "MODEL_EXECUTION_FAILED", diagnosticCode, retryable: false });
      expect(timeToSafeFixDriverResultSchema.shape.failure.parse(failure)).toEqual(failure);
      const projection = sanitizeOperationalError(wrapped);
      expect(projection.diagnosticCode).toBe(diagnosticCode);
      expect(sanitizeOperationalError(restoreSanitizedOperationalError(projection)).diagnosticCode).toBe(diagnosticCode);
      expect(JSON.stringify({ failure, projection, error })).not.toContain(sentinel);
    });
  }
}

test("unknown or mismatched Qwen diagnostic metadata is not trusted", () => {
  for (const metadata of [
    { provider: "other", category: "provider-tool-call", transport: "responses", diagnosticCode: "QWEN_RESPONSES_TOOL_CALL_INVALID" },
    { provider: "qwen", category: "provider-tool-call", transport: "chat", diagnosticCode: "QWEN_RESPONSES_TOOL_CALL_INVALID" },
    { provider: "qwen", name: "QwenStreamEventError", transport: "responses", diagnosticCode: sentinel }
  ]) {
    expect(classifyTimeToSafeFixFailure(Object.assign(new Error("opaque"), metadata)).diagnosticCode).toBeUndefined();
  }
});
