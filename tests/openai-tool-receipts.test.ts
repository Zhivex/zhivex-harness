import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@zhivex-ai/openai";
import type { ModelGenerateInput } from "@zhivex-ai/core";
import { providerModelInternals } from "../src/providers/providers.js";

const input = (name: string, isError = false, native = false): ModelGenerateInput => ({
  providerOptions: { apiMode: "responses" },
  messages: [
    { role: "user", parts: [{ type: "text", text: "Use the approved result." }] },
    { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call_fixture", name, input: {} } }] },
    { role: "tool", parts: [{ type: "tool-result", toolResult: {
      toolCallId: "call_fixture", toolName: name, isError,
      ...(isError ? { error: { message: "fixture failure" } } : { output: native
        ? { status: "completed", output: "native fixture" }
        : { schemaVersion: 1, kind: "patch-result", result: { changes: [{ operation: "create", path: "fixture.txt" }] } } }),
      ...(native ? { providerMetadata: { responsesToolType: "apply_patch" } } : {})
    } }] }
  ]
});

describe("OpenAI function receipts across native tool name collisions", () => {
  for (const mode of ["generate", "stream"] as const) {
    for (const name of ["apply_patch", "shell", "computer", "ordinary_tool"]) {
      for (const isError of [false, true]) {
        test(`${mode} preserves ${name} ${isError ? "error" : "success"} payload`, async () => {
          let body: any;
          const model = providerModelInternals.withOpenAIToolResultEnvelopes(createOpenAI({
            apiKey: "fixture-key",
            fetch: (async (_url, init) => {
              body = JSON.parse(String(init?.body));
              const response = { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } };
              return mode === "generate" ? Response.json(response) : new Response(
                `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              );
            }) as typeof fetch
          })("gpt-6-luna"));
          const request = input(name, isError);
          if (mode === "generate") await model.generate(request);
          else for await (const _event of await model.stream!(request)) { /* consume transport */ }
          const receipt = body.input.at(-1);
          expect(receipt.type).toBe("function_call_output");
          expect(receipt.call_id).toBe("call_fixture");
          const payload = JSON.parse(receipt.output);
          expect("error" in payload).toBe(isError);
          if (isError) expect(payload.error.message).toBe("fixture failure");
          else expect(payload.output).toEqual((request.messages[2]!.parts[0] as any).toolResult.output);
        });
      }
    }
    test(`${mode} preserves explicitly native apply_patch metadata`, async () => {
      let body: any;
      const model = providerModelInternals.withOpenAIToolResultEnvelopes(createOpenAI({ apiKey: "fixture", fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        const response = { id: "resp_fixture", status: "completed", output: [] };
        return mode === "generate" ? Response.json(response) : new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
      }) as typeof fetch })("gpt-6-luna"));
      if (mode === "generate") await model.generate(input("apply_patch", false, true));
      else for await (const _event of await model.stream!(input("apply_patch", false, true))) { /* consume */ }
      expect(body.input.at(-1)).toEqual({ type: "apply_patch_call_output", call_id: "call_fixture", status: "completed", output: "native fixture" });
    });
  }
});
