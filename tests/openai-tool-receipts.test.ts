import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@zhivex-ai/openai";
import type { ModelGenerateInput } from "@zhivex-ai/core";
import { providerModelInternals } from "../src/providers/providers.js";

const input = (name: string, isError = false, native = false): ModelGenerateInput => ({
  providerOptions: { apiMode: "responses" },
  messages: [
    { role: "user", parts: [{ type: "text", text: "Use the approved result." }] },
    { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call_fixture", name, input: {}, ...(native ? { providerMetadata: { responsesToolType: "apply_patch" } } : {}) } }] },
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

for (const mode of ["generate", "stream"] as const) test(`OpenAI ${mode} keeps fresh-edit and retry fields optional on the wire`, async () => {
  const { z } = await import("zod");
  const { wrapLanguageModel } = await import("@zhivex-ai/core");
  const { createModelEditReferences } = await import("../src/runtime/model-edit-references.js");
  const { editChangesSchema } = await import("../src/workspace/edit-contracts.js");
  const { replacementEditSchema } = await import("../src/workspace/replacement-edits.js");
  const schemas = {
    apply_reviewed_edits: z.strictObject({ changes: editChangesSchema }),
    verify_and_apply_reviewed_edits: z.strictObject({ changes: editChangesSchema, command: z.string(), args: z.array(z.string()) }),
    apply_reviewed_replacement: replacementEditSchema,
    unrelated: z.strictObject({ value: z.string() })
  };
  const tools = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, {
    name, schema, metadata: { "openai.responses_function_config": { defer_loading: true } }, execute: async () => null
  }]));
  let body: any;
  const model = wrapLanguageModel(createOpenAI({ apiKey: "fixture", fetch: (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    const response = { id: "resp_optional", status: "completed", output: [] };
    return mode === "generate" ? Response.json(response) : new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  }) as typeof fetch })("gpt-6-luna"), [createModelEditReferences(tools)]);
  const request = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "Repair" }] }], tools,
    providerOptions: { apiMode: "responses" as const } };
  if (mode === "generate") await model.generate(request);
  else for await (const _event of await model.stream!(request)) { /* consume published SDK transport */ }
  for (const name of Object.keys(schemas)) {
    const sent = body.tools.find((tool: any) => tool.name === name);
    expect(sent.defer_loading).toBe(true);
    if (name === "unrelated") { expect(sent.strict).toBeUndefined(); continue; }
    expect(sent.strict).toBe(false);
    expect(sent.parameters.required ?? []).not.toContain("retryToolCallId");
    expect(sent.parameters.required ?? []).not.toContain("createPaths");
  }
  // Presentation settings never weaken the host's execution schema or mutate
  // the registered definitions consumed by approval and persistence.
  expect(schemas.apply_reviewed_edits.safeParse({ changes: [{ path: "a.txt", content: "after" }] }).success).toBe(false);
  expect(schemas.apply_reviewed_edits.safeParse({ retryToolCallId: "invented" }).success).toBe(false);
  expect(tools.apply_reviewed_edits!.metadata).toEqual({ "openai.responses_function_config": { defer_loading: true } });
});
