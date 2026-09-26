import { expect, test } from "bun:test";
import { createMockLanguageModel, wrapLanguageModel, type ModelGenerateInput } from "@zhivex-ai/core";
import { createModelBudget } from "../src/runtime/model-budget.js";

const saved = { inputTokens: 100, outputTokens: 1500, cachedInputTokens: 0, modelCalls: 1, usageComplete: true };
const limits = { inputTokens: 100_000, outputTokens: 10_000 };
const usage = { inputTokens: 10, outputTokens: 100, totalTokens: 110 };

for (const streaming of [false, true]) for (const closure of [false, true]) {
  test(`repair output default uses remaining ${closure ? "total" : "work"} budget (${streaming ? "stream" : "generate"})`, async () => {
    const budget = createModelBudget(limits, { saved, closure: () => closure });
    const base = createMockLanguageModel({ responses: [{ finishReason: "stop", usage }],
      streamEvents: [[{ type: "finish", finishReason: "stop", usage }]] });
    let cap: number | undefined;
    const generate = base.generate;
    base.generate = input => { cap = input.maxTokens; return generate(input); };
    const stream = base.stream!;
    base.stream = input => { cap = input.maxTokens; return stream(input); };
    const model = wrapLanguageModel(base, [budget.middleware]);
    if (streaming) for await (const _ of await model.stream!({ messages: [] })) { /* consume */ }
    else await model.generate({ messages: [] });
    expect(cap).toBe(closure ? 8500 : 5500);
    expect(budget.stats.outputCapApplied).toBe(true);
    expect(budget.stats.outputTokens).toBe(1600);
  });
}

for (const cap of [777, 9000]) test(`repair respects explicit output cap ${cap} within remaining phase budget`, async () => {
  const budget = createModelBudget(limits, { saved });
  const input: ModelGenerateInput = { messages: [], maxTokens: cap };
  await budget.middleware.wrapGenerate!({ input, model: createMockLanguageModel() }, async () => ({ usage }));
  expect(input.maxTokens).toBe(Math.min(cap, 5500));
});

for (const explicit of [undefined, 777]) test(`unlimited repair output never injects Infinity (explicit=${explicit})`, async () => {
  const budget = createModelBudget({ inputTokens: Infinity, outputTokens: Infinity });
  const input: ModelGenerateInput = { messages: [], ...(explicit === undefined ? {} : { maxTokens: explicit }) };
  await budget.middleware.wrapGenerate!({ input, model: createMockLanguageModel() }, async () => ({ usage }));
  expect(input.maxTokens).toBe(explicit);
  expect(budget.stats.outputCapApplied).toBe(explicit !== undefined);
  expect(JSON.stringify(input)).not.toContain('"maxTokens":null');
  expect(JSON.parse(JSON.stringify(budget.snapshot())).outputTokens).toBe(100);
});

for (const route of [undefined, "auto", "responses", "chat"] as const) {
  test(`repair output default preserves Qwen ${route ?? "unspecified"} route`, async () => {
    const budget = createModelBudget(limits, { saved });
    const input: ModelGenerateInput = { messages: [], ...(route ? { providerOptions: { apiMode: route } } : {}) };
    await budget.middleware.wrapGenerate!({ input, model: createMockLanguageModel({ provider: "qwen" }) }, async () => ({ usage }));
    expect(input.maxTokens).toBe(route === "chat" ? 5500 : undefined);
    expect(budget.stats.outputCapApplied).toBe(route === "chat");
    expect(input.providerOptions?.apiMode).toBe(route);
  });
}

test("Qwen explicit auto cap retains existing Chat routing intent", async () => {
  const budget = createModelBudget(limits, { saved });
  const input: ModelGenerateInput = { messages: [], providerOptions: { apiMode: "auto" }, maxTokens: 777 };
  await budget.middleware.wrapGenerate!({ input, model: createMockLanguageModel({ provider: "qwen" }) }, async () => ({ usage }));
  expect(input.maxTokens).toBe(777);
  expect(input.providerOptions?.apiMode).toBe("auto");
});
