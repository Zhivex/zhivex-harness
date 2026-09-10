// Consumer contract adapted from the SDK suite; all HTTP is mocked.
import { describe, expect, it } from "bun:test";
import { createTextMessage, generateText, streamText, type ModelMessage } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

describe("Responses synthetic assistant history", () => {
  it.each([false, true])("uses output_text without changing roles (stream=%s)", async (streaming) => {
    let request: any;
    const model = createOpenAI({ apiKey: "test", fetch: (async (_url, init) => {
      request = JSON.parse(String(init?.body));
      const response = { id: "resp_test", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }] };
      return streaming ? new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
    }) as typeof fetch })("gpt-5.6");
    const messages: ModelMessage[] = [
      createTextMessage("system", "Be precise."),
      createTextMessage("assistant", "[Compacted prior conversation]\nEarlier context."),
      { role: "assistant", parts: [{ type: "text", text: "Inspecting." }, { type: "tool-call", toolCall: { id: "check-1", name: "inspect", input: {} } }] },
      { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "check-1", toolName: "inspect", output: "ok", isError: false } }] },
      createTextMessage("user", "Continue.")
    ];
    const original = structuredClone(messages);
    if (streaming) {
      const result = streamText({ model, messages });
      await Array.fromAsync(result.eventStream);
      await result.collect();
    } else await generateText({ model, messages });
    expect(request.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "Be precise." }] },
      { role: "assistant", content: [{ type: "output_text", text: "[Compacted prior conversation]\nEarlier context.", annotations: [] }] },
      { role: "assistant", content: [{ type: "output_text", text: "Inspecting.", annotations: [] }] },
      { type: "function_call", call_id: "check-1", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "check-1", output: JSON.stringify("ok") },
      { role: "user", content: [{ type: "input_text", text: "Continue." }] }
    ]);
    expect(messages).toEqual(original);
  });
});
