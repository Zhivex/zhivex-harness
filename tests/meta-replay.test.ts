import { expect, test } from "bun:test";
import type { ModelMessage } from "@zhivex-ai/core";
import { createMetaReplayModel } from "../src/providers/meta-replay.js";

const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "opaque-fixture" };
const response = { id: "resp_new", status: "completed", output: [reasoning,
  { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read_file", arguments: '{"path":"README.md"}' }
] };
const receipt: ModelMessage = { role: "tool", parts: [{ type: "tool-result", toolResult: {
  toolCallId: "call_fixture", toolName: "read_file", output: "contents", isError: false
} }] };

for (const mode of ["generate", "stream"] as const) test(`Meta ${mode} retains encrypted output and replays it without server state`, async () => {
  const bodies: any[] = [];
  const model = createMetaReplayModel({ apiKey: "fixture", fetch: Object.assign(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (mode === "generate") return Response.json(response);
    return new Response([
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item: response.output[1] },
      { type: "response.completed", response }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  }, { preconnect: fetch.preconnect }) }, "muse-spark-1.3");
  const history: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Read the file" }] }];
  let assistant: ModelMessage;
  if (mode === "generate") assistant = (await model.generate({ messages: history })).messages![0]!;
  else {
    assistant = { role: "assistant", parts: [] };
    for await (const event of await model.stream!({ messages: history })) {
      if (event.type === "provider-data") assistant.parts.push({ type: "provider-data", provider: event.provider, data: event.data });
      if (event.type === "tool-call") assistant.parts.push({ type: "tool-call", toolCall: event.toolCall });
    }
  }
  expect(assistant.parts.some(part => part.type === "provider-data" && JSON.stringify(part.data).includes("opaque-fixture"))).toBe(true);
  const messages = [...history, assistant, receipt];
  const original = JSON.stringify(messages);
  const input = { messages, providerOptions: { store: true, previous_response_id: "stale_override", include: ["reasoning.encrypted_content"] } };
  if (mode === "generate") await model.generate(input);
  else for await (const _event of await model.stream!(input)) { /* consume */ }
  expect(JSON.stringify(messages)).toBe(original);
  expect(bodies[1].previous_response_id).toBeUndefined();
  expect(bodies[1].store).toBe(false);
  expect(bodies[1].include).toEqual(["reasoning.encrypted_content"]);
  expect(bodies[1].input.map((item: any) => item.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
  expect(bodies[1].input[1]).toEqual(reasoning);
  expect(bodies[1].input[2].call_id).toBe(bodies[1].input[3].call_id);
});

test("legacy IDs cannot suppress current instructions or require remote state; concurrent invocations stay isolated", async () => {
  const bodies: any[] = [];
  const model = createMetaReplayModel({ apiKey: "fixture", fetch: Object.assign(async (_url: unknown, init?: RequestInit) => {
    await Promise.resolve();
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "resp_new", status: "completed", output: [] });
  }, { preconnect: fetch.preconnect }) }, "muse-spark-1.3");
  await Promise.all(["a", "b"].map(label => model.generate({ messages: [
    { role: "system", parts: [{ type: "text", text: `instructions-${label}` }] },
    { role: "assistant", parts: [
      { type: "provider-data", provider: "meta", data: { responseId: "expired" } },
      { type: "provider-data", provider: "meta", data: { type: "reasoning", summary: [] } },
      { type: "text", text: `old-${label}` }
    ] },
    { role: "assistant", parts: [{ type: "provider-data", provider: "meta", data: { ...reasoning, encrypted_content: label } }] },
    { role: "user", parts: [{ type: "text", text: `new-${label}` }] }
  ] })));
  for (const body of bodies) {
    const label = body.input[2].encrypted_content;
    expect(body.input.map((item: any) => item.type)).toEqual(["message", "message", "reasoning", "message"]);
    expect(body.input[0].content[0].text).toBe(`instructions-${label}`);
    expect(body.input[3].content[0].text).toBe(`new-${label}`);
    expect(body.previous_response_id).toBeUndefined();
  }
});
