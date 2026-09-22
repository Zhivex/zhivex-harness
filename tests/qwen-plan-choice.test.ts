import { expect, test } from "bun:test";
import { createQwen } from "@zhivex-ai/qwen";
import { tool, wrapLanguageModel } from "@zhivex-ai/core";
import { z } from "zod";
import { createRepairController } from "../src/runtime/repair-controller.js";

test("Qwen serializes the controller's required repair plan on the Chat wire", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchFixture = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const controller = createRepairController({}, true);
  controller.state.planRequired = true;
  const definition = (name: string) => tool({ name, schema: z.object({}), execute: () => ({}) });
  const model = wrapLanguageModel(createQwen({ apiKey: "fixture", fetch: fetchFixture })("qwen3.8-flash"), [controller.middleware]);
  await Array.fromAsync(await model.stream!({ messages: [{ role: "user", parts: [{ type: "text", text: "fixture" }] }],
    tools: { repair_plan: definition("repair_plan"), read_task: definition("read_task"), read_files: definition("read_files") },
    reasoning: { effort: "none" }, providerOptions: { apiMode: "chat", enable_thinking: false } }));
  expect(body?.tool_choice).toEqual({ type: "function", function: { name: "repair_plan" } });
  expect(body?.enable_thinking).toBe(false);
  expect((body?.tools as { function: { name: string } }[]).map(item => item.function.name).sort()).toEqual(["read_task", "repair_plan"]);
});
