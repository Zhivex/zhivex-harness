import { expect, test } from "bun:test";
import { ProviderToolCallError } from "@zhivex-ai/core/provider";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { TokenUsage, StreamEvent } from "@zhivex-ai/core";
import { createModelBudget } from "../src/model-budget.js";

const failure = (usage?: unknown, provider = "openai") => Object.assign(new ProviderToolCallError({
  provider, reason: "incomplete_arguments", diagnosticCode: "FIXTURE"
}), usage === undefined ? {} : { usage });
const context = () => ({ input: { messages: [] }, model: createMockLanguageModel({ provider: "openai" }) });
const budget = () => createModelBudget({ inputTokens: 1000, outputTokens: 1000 });
test("published OpenAI adapter preserves rejected stream usage through runHarness without executing tools", async () => {
  const child = Bun.spawn([process.execPath, "run", "scripts/validate-openai-harness-usage.mjs"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ passed: true, failed: true, toolExecutions: 0,
    inputTokens: 12, outputTokens: 8, usageComplete: true, network: "mock-only" });
});
for (const mode of ["generate", "stream-open", "stream-body"] as const) {
  test(`records terminal failure usage and preserves the error: ${mode}`, async () => {
    const b = budget(), error = failure({ inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 });
    const run = async () => {
      if (mode === "generate") return b.middleware.wrapGenerate!(context(), async () => { throw error; });
      const stream = await b.middleware.wrapStream!(context(), async () => {
        if (mode === "stream-open") throw error;
        return (async function* (): AsyncIterable<StreamEvent> { throw error; })();
      });
      for await (const event of stream) throw new Error(`Unexpected event ${event.type}`);
    };
    await expect(run()).rejects.toBe(error);
    expect(b.snapshot()).toMatchObject({ inputTokens: 12, outputTokens: 8, cachedInputTokens: 4, usageComplete: true, inFlight: false });
    expect(b.modelTimings).toHaveLength(1);
    expect(b.modelTimings[0]?.completed).toBe(false);
    const restored = createModelBudget({ inputTokens: 1000, outputTokens: 1000 }, { saved: b.snapshot() });
    expect(restored.stats.inputTokens).toBe(12);
  });
}
for (const error of [failure(), failure({ inputTokens: 12 }), failure({ inputTokens: 12, outputTokens: -1 }),
  failure({ inputTokens: 12, outputTokens: 8 }, "qwen"), { usage: { inputTokens: 12, outputTokens: 8 } }]) {
  test("unknown, invalid or unrelated error usage remains unavailable", async () => {
    const b = budget();
    await expect(b.middleware.wrapGenerate!(context(), async () => { throw error; })).rejects.toBe(error);
    expect(b.stats.usageComplete).toBe(false);
    await expect(b.middleware.wrapGenerate!(context(), async () => ({}))).rejects.toThrow("USAGE_UNAVAILABLE");
  });
}
test("does not count terminal usage twice when an error follows finish", async () => {
  const b = budget(), usage: TokenUsage = { inputTokens: 12, outputTokens: 8 }, error = failure(usage);
  const run = async () => {
    const stream = await b.middleware.wrapStream!(context(), async () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "finish", finishReason: "length", usage }; throw error;
    })());
    for await (const _event of stream) { /* drain */ }
  };
  await expect(run()).rejects.toBe(error);
  expect(b.stats.inputTokens).toBe(12); expect(b.stats.outputTokens).toBe(8);
});
