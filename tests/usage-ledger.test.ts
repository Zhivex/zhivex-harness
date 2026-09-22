import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { UsageLedger, usagePricingSchema, type UsageAccountingOptions } from "../src/runtime/usage-ledger.js";

const roots: string[] = [], ledgers: UsageLedger[] = [];
afterEach(async () => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = Date.parse("2026-09-20T12:00:00Z");
const pricing = { schemaVersion: 1 as const, prices: ["a", "b"].map(provider => ({ provider, model: "model", inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "operator test fixture", asOf: "2026-09-20T00:00:00Z", expiresAt: "2026-09-21T00:00:00Z" })) };
const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }] };
const model = (provider = "a", withUsage = true) => createMockLanguageModel({ provider, modelId: "model", responses: [{
  text: "done", messages: [], finishReason: "stop", ...(withUsage ? { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } : {})
}] });
async function fixture(options: UsageAccountingOptions = {}, time = now) {
  const root = await mkdtemp(path.join(os.tmpdir(), "har-usage-")); roots.push(root);
  const config = resolveHarnessConfig({ workspace: root });
  const ledger = await UsageLedger.open(config, options, () => time); ledgers.push(ledger);
  return { config, ledger };
}

test("records heterogeneous transport calls once and restores frozen policy across restarts", async () => {
  const { ledger, config } = await fixture({ pricing, limitUsd: 0.01 });
  await ledger.run("task", async () => {
    await ledger.model(model()).generate(input);
    await ledger.model(model("b")).generate(input);
  });
  expect(ledger.summary("task")).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10, usageComplete: true, limitUsd: 0.01 });
  ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1);
  const resumed = await UsageLedger.open(config, { limitUsd: 100 }, () => now); ledgers.push(resumed);
  expect(resumed.summary("task").calls).toBe(2);
  await resumed.run("task", () => resumed.model(model()).generate(input));
  expect(resumed.summary("task")).toMatchObject({ calls: 3, limitUsd: 0.01 });
  expect(resumed.summary("task").routes).toHaveLength(2);
});

test("missing and expired prices block before any provider call under a monetary limit", async () => {
  for (const options of [{ limitUsd: 1 }, { limitUsd: 1, pricing }]) {
    const { ledger } = await fixture(options, now + 48 * 3600_000);
    await expect(ledger.run("task", () => ledger.model(model()).generate(input))).rejects.toThrow("USAGE_PRICE_");
    expect(ledger.summary("task").calls).toBe(0);
  }
});

test("unknown usage and partial failure remain visible and block subsequent monetary calls", async () => {
  const { ledger } = await fixture({ limitUsd: 1, pricing });
  const failing = model();
  failing.generate = async () => { throw new Error("connection lost"); };
  await expect(ledger.run("task", () => ledger.model(failing).generate(input))).rejects.toThrow("connection lost");
  expect(ledger.summary("task")).toMatchObject({ calls: 1, usageComplete: false, estimatedUsd: null });
  await expect(ledger.run("task", () => ledger.model(model()).generate(input))).rejects.toThrow("USAGE_UNCERTAIN");
  expect(ledger.summary("task").calls).toBe(1);
});

test("an unpriced route reports unknown cost without inventing zero", async () => {
  const { ledger } = await fixture();
  await ledger.run("task", () => ledger.model(model()).generate(input));
  expect(ledger.summary("task")).toMatchObject({ estimatedUsd: null, usageComplete: true });
  expect(ledger.summary("task").routes[0]?.priceStatuses).toEqual(["missing"]);
});

test("reserves the next request and refuses an exhausted cap before transport", async () => {
  const { ledger } = await fixture({ pricing, limitUsd: 0.000001 });
  await expect(ledger.run("task", () => ledger.model(model()).generate(input))).rejects.toThrow("USAGE_COST_BUDGET");
  expect(ledger.summary("task").calls).toBe(0);
});

test("parallel heterogeneous calls share reservations before either one completes", async () => {
  const { ledger } = await fixture({ pricing, limitUsd: 0.005 });
  const slow = model(); const generate = slow.generate.bind(slow);
  slow.generate = async input => { await new Promise(resolve => setTimeout(resolve, 10)); return generate(input); };
  const results = await ledger.run("parallel", () => Promise.allSettled([
    ledger.model(slow).generate(input), ledger.model(model("b")).generate(input)
  ]));
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(ledger.summary("parallel")).toMatchObject({ calls: 1, usageComplete: true });
});

test("price documents reject duplicate routes and inverted validity", () => {
  expect(usagePricingSchema.safeParse({ ...pricing, prices: [pricing.prices[0], pricing.prices[0]] }).success).toBe(false);
  expect(usagePricingSchema.safeParse({ ...pricing, prices: [{ ...pricing.prices[0], expiresAt: "2026-09-19T00:00:00Z" }] }).success).toBe(false);
});

test("missing imported ledger and pre-ledger history cannot masquerade as a fresh budget", async () => {
  const { ledger } = await fixture({ pricing, limitUsd: 1 });
  expect(() => ledger.assertResume("imported")).toThrow("USAGE_LEDGER_MISSING");
  await expect(ledger.run("legacy", () => ledger.model(model()).generate(input), true)).rejects.toThrow("USAGE_UNCERTAIN");
  expect(ledger.summary("legacy")).toMatchObject({ historicalUsageUnknown: true, usageComplete: false, estimatedUsd: null });
});

test("a process loss with an in-flight request cannot restore a fresh monetary budget", async () => {
  const { ledger, config } = await fixture({ pricing, limitUsd: 1 });
  const hanging = model();
  hanging.generate = () => new Promise(() => {});
  void ledger.run("crashed", () => ledger.model(hanging).generate(input));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(ledger.summary("crashed")).toMatchObject({ calls: 1, usageComplete: false });
  ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1);
  const restored = await UsageLedger.open(config, {}, () => now); ledgers.push(restored);
  await expect(restored.run("crashed", () => restored.model(model()).generate(input))).rejects.toThrow("USAGE_UNCERTAIN");
  expect(restored.summary("crashed").limitUsd).toBe(1);
});

test("duplicate streaming finish events and stream cleanup settle exactly one call", async () => {
  const { ledger } = await fixture({ pricing });
  const streamModel = createMockLanguageModel({ provider: "a", modelId: "model", streamEvents: [[
    { type: "text-delta", textDelta: "done" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  ]] });
  await ledger.run("stream", async () => { for await (const _event of await ledger.model(streamModel).stream!(input)) { /* drain */ } });
  expect(ledger.summary("stream")).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5, usageComplete: true });
});
