import { expect, test } from "bun:test";
import { z } from "zod";
import { tool, wrapLanguageModel, type LanguageModelMiddleware } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createCatalogObserver } from "../scripts/swebench/model-catalog.js";

const tools = { read_task: tool({ name: "read_task", schema: z.object({}), execute: () => "PRIVATE_OUTPUT" }),
  repair_plan: tool({ name: "repair_plan", schema: z.object({}), execute: () => null }) };
const messages = [{ role: "system" as const, parts: [{ type: "text" as const, text: "PRIVATE_POLICY" }] }];

test("catalog observation sees policy-narrowed input and distinguishes offered from registered tools", async () => {
  const observer = createCatalogObserver(Object.keys(tools));
  const base = createMockLanguageModel({ streamEvents: [[
    { type: "tool-call", toolCall: { id: "private-id", name: "repair_plan", input: { secret: "PRIVATE_ARGUMENT" } } },
    { type: "tool-call", toolCall: { id: "private-id2", name: "PRIVATE_TOOL", input: {} } },
    { type: "finish", finishReason: "tool-calls" }
  ]] });
  const policy: LanguageModelMiddleware = { name: "narrow", async wrapStream(context, next) {
    context.input.tools = { read_task: tools.read_task };
    return next();
  } };
  const model = wrapLanguageModel(wrapLanguageModel(base, [observer.middleware]), [policy]);
  const events = await Array.fromAsync(await model.stream!({ messages, tools }));
  expect(events).toHaveLength(3);
  expect(events[1]).toMatchObject({ toolCall: { name: "PRIVATE_TOOL" } });
  expect(observer.snapshot().records).toEqual([{ call: 1, offered: ["read_task"], unknownOffered: 0,
    systemMessages: 1, choice: "default", completed: true, omittedReturned: 0,
    returned: [{ name: "repair_plan", offered: false, registered: true },
      { name: "other-tool", offered: false, registered: false }] }]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE");
});

test("catalog observation retains partial evidence and propagates streaming failure", async () => {
  const observer = createCatalogObserver(["read_task"]);
  const base = createMockLanguageModel({});
  const failure = new Error("PRIVATE_ERROR");
  base.stream = async () => (async function* () {
    yield { type: "tool-call" as const, toolCall: { id: "1", name: "read_task", input: {} } };
    throw failure;
  })();
  const model = wrapLanguageModel(base, [observer.middleware]);
  await expect(Array.fromAsync(await model.stream!({ messages, tools }))).rejects.toBe(failure);
  expect(observer.snapshot().records[0]).toMatchObject({ completed: false,
    returned: [{ name: "read_task", offered: true, registered: true }] });
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE");
});

test("catalog observation bounds non-streaming evidence and never exports external names", async () => {
  const observer = createCatalogObserver(["PRIVATE_TOOL"]);
  const base = createMockLanguageModel({ responses: Array.from({ length: 101 }, () => ({
    messages: [{ role: "assistant" as const, parts: Array.from({ length: 65 }, (_, i) => ({ type: "tool-call" as const,
      toolCall: { id: String(i), name: "PRIVATE_TOOL", input: {} } })) }], finishReason: "tool-calls" as const
  })) });
  const model = wrapLanguageModel(base, [observer.middleware]);
  for (let i = 0; i < 101; i++) await model.generate({ messages, tools: { PRIVATE_TOOL: tools.read_task } });
  const snapshot = observer.snapshot();
  expect(snapshot.records).toHaveLength(100);
  expect(snapshot.omittedCalls).toBe(1);
  expect(snapshot.records[0]).toMatchObject({ offered: [], unknownOffered: 1, omittedReturned: 1, completed: true });
  expect(snapshot.records[0]!.returned).toHaveLength(64);
  expect(snapshot.records[0]!.returned[0]).toEqual({ name: "other-tool", offered: true, registered: true });
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
});
