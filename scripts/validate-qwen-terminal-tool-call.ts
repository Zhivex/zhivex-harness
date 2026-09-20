/** Offline acceptance: valid Chat tool fragments ending with stop must not disappear. */
import { createQwen } from "@zhivex-ai/qwen";
import { tool } from "@zhivex-ai/core";
import { z } from "zod";

const chunks = [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "repair_plan", arguments: '{"value":' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }
];
const model = createQwen({ apiKey: "fixture", fetch: (async () => new Response(
  chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch })("qwen3.8-flash");
const events = await Array.fromAsync(await model.stream!({
  messages: [{ role: "user", parts: [{ type: "text", text: "fixture" }] }],
  tools: { repair_plan: tool({ name: "repair_plan", schema: z.object({ value: z.string() }), execute: (): string => { throw new Error("must not execute"); } }) },
  toolChoice: { type: "tool", toolName: "repair_plan" }, reasoning: { effort: "none" },
  providerOptions: { apiMode: "chat", enable_thinking: false }
}));
const calls = events.filter(event => event.type === "tool-call");
const finish = events.find(event => event.type === "finish");
const passed = calls.length === 1 && calls[0]!.toolCall.name === "repair_plan" &&
  finish?.finishReason === "tool-calls";
console.log(JSON.stringify({ passed, toolCalls: calls.length, finishReason: finish?.finishReason,
  usage: finish?.usage, network: "mock-only", toolExecution: false }));
if (!passed) process.exitCode = 1;
