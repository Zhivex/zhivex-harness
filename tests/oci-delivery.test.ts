import { expect, test } from "bun:test";
import { Agent, tool } from "@zhivex-ai/agents";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import type { ModelGenerateInput, StreamEvent } from "@zhivex-ai/core";
import { z } from "zod";
import { createOciDelivery, OCI_DELIVERY_KEY } from "../src/runtime/oci-delivery.js";

const model = createMockLanguageModel();
const input = (): ModelGenerateInput => ({ messages: [], tools: {
  inspect_environment_patch: tool({ name: "inspect_environment_patch", schema: z.object({}), execute: async () => ({ entries: [] }) })
} });
const finish: StreamEvent = { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } };
const events = async function* (values: StreamEvent[] = [finish]): AsyncIterable<StreamEvent> { yield* values; };
const collect = async (stream: AsyncIterable<StreamEvent>) => { const result: StreamEvent[] = []; for await (const event of stream) result.push(event); return result; };
const state = async () => (await new Agent({ model: createMockLanguageModel({ responses: [{ message: { role: "assistant", parts: [{ type: "text", text: "complete" }] }, finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } }] }) }).run({ prompt: "fixture", runId: "delivery-run" })).state;

for (const scenario of ["pending", "delivered", "no-tools", "declined", "length", "tool-call"] as const) {
  test(`OCI completion reminder respects ${scenario}`, async () => {
    let inspections = 0;
    const delivery = createOciDelivery(async () => { inspections++; return scenario !== "delivered"; }, {});
    if (scenario === "declined") delivery.resolved("apply_environment_patch", false);
    const request = input();
    if (scenario === "no-tools") delete request.tools;
    const values: StreamEvent[] = scenario === "tool-call"
      ? [{ type: "tool-call", toolCall: { id: "provider-call", name: "inspect_environment_patch", input: {} } }, finish]
      : [{ ...finish, finishReason: scenario === "length" ? "length" : "stop" }];
    const result = await collect(await delivery.middleware.wrapStream!({ input: request, model }, async () => events(values)));
    const synthetic = result.filter(event => event.type === "tool-call" && event.toolCall.id.startsWith("oci_delivery_"));
    expect(synthetic).toHaveLength(scenario === "pending" ? 1 : 0);
    expect(result.at(-1)).toMatchObject({ usage: finish.usage });
    expect(inspections).toBe(["pending", "delivered"].includes(scenario) ? 1 : 0);
  });
}

test("reminder limit and refusal persist across saved state and restart", async () => {
  const base = createInMemoryAgentRunStore();
  let saved = await state();
  let delivery = createOciDelivery(async () => true, {});
  for (let turn = 0; turn < 3; turn++) {
    const result = await collect(await delivery.middleware.wrapStream!({ input: input(), model }, async () => events()));
    expect(result.filter(event => event.type === "tool-call")).toHaveLength(turn < 2 ? 1 : 0);
    saved.status = "running";
    await delivery.store(base, saved.runId).save(saved);
    saved = (await base.load(saved.runId))!;
    expect(saved.metadata?.[OCI_DELIVERY_KEY]).toMatchObject({ reminders: Math.min(turn + 1, 2), declined: false });
    delivery = createOciDelivery(async () => true, saved.metadata ?? {});
  }
  delivery.resolved("verify_and_apply_environment_patch", false);
  saved.status = "completed";
  saved.finalOutput = "optimistic claim";
  const previousUsage = saved.usage;
  await delivery.store(base, saved.runId).save(saved);
  const declined = (await base.load(saved.runId))!;
  expect(declined.status).toBe("failed");
  expect(declined.error?.message).toBe("OCI_DELIVERY_DECLINED");
  expect(declined.finalOutput).toBeUndefined();
  expect(declined.usage).toEqual(previousUsage);
  delivery = createOciDelivery(async () => true, declined.metadata ?? {});
  expect(await collect(await delivery.middleware.wrapStream!({ input: input(), model }, async () => events())))
    .toEqual([finish]);
});

for (const scenario of ["pending", "inspection-failed", "delivered"] as const) {
  test(`durable completion is truthful for ${scenario}`, async () => {
    const base = createInMemoryAgentRunStore();
    const delivery = createOciDelivery(async () => {
      if (scenario === "inspection-failed") throw new Error("private path");
      return scenario === "pending";
    }, {});
    const saved = await state();
    saved.finalOutput = "done";
    await delivery.store(base, saved.runId).save(saved);
    const result = (await base.load(saved.runId))!;
    expect(result.status).toBe(scenario === "delivered" ? "completed" : "failed");
    if (scenario !== "delivered") {
      expect(result.error?.message).toBe(scenario === "pending" ? "OCI_DELIVERY_PENDING" : "OCI_DELIVERY_INSPECTION_FAILED");
      expect(result.finalOutput).toBeUndefined();
      expect(JSON.stringify(result.error)).not.toContain("private path");
    }
  });
}

test("late stream failure cannot create a synthetic inspection or consume allowance", async () => {
  let inspections = 0;
  const delivery = createOciDelivery(async () => { inspections++; return true; }, {});
  const error = new Error("late failure");
  const stream = await delivery.middleware.wrapStream!({ input: input(), model }, async () => (async function* () {
    yield finish; throw error;
  })());
  await expect(collect(stream)).rejects.toBe(error);
  expect(inspections).toBe(0);
  const next = await collect(await delivery.middleware.wrapStream!({ input: input(), model }, async () => events()));
  expect(next.some(event => event.type === "tool-call")).toBe(true);
});

test("generate appends inspection without changing signed reasoning or usage", async () => {
  const delivery = createOciDelivery(async () => true, {});
  const opaque = { type: "provider-data" as const, provider: "anthropic", data: { type: "thinking", thinking: "reason", signature: "opaque-signed-value" } };
  const result = await delivery.middleware.wrapGenerate!({ input: input(), model }, async () => ({
    message: { role: "assistant", parts: [opaque, { type: "text", text: "done" }] }, finishReason: "stop", usage: finish.usage!
  }));
  expect(result.message?.parts.slice(0, 2)).toEqual([opaque, { type: "text", text: "done" }]);
  expect(result.message?.parts.at(-1)).toMatchObject({ type: "tool-call", toolCall: { name: "inspect_environment_patch" } });
  expect(result.usage).toEqual(finish.usage);
  expect(result.finishReason).toBe("tool-calls");
});

test("an explicit late error event never schedules a completion reminder", async () => {
  let inspections = 0;
  const delivery = createOciDelivery(async () => { inspections++; return true; }, {});
  const failure: StreamEvent = { type: "error", error: new Error("provider failure") };
  const result = await collect(await delivery.middleware.wrapStream!({ input: input(), model }, async () => events([finish, failure])));
  expect(result.some(event => event.type === "tool-call")).toBe(false);
  expect(inspections).toBe(0);
  expect(result).toContain(failure);
});

test("delivery decorator does not overwrite failed runs or inspect another run", async () => {
  let inspections = 0;
  const delivery = createOciDelivery(async () => { inspections++; return true; }, {});
  const base = createInMemoryAgentRunStore();
  const saved = await state();
  saved.status = "failed";
  saved.error = { message: "original verification failure" };
  await delivery.store(base, saved.runId).save(saved);
  expect((await base.load(saved.runId))?.error?.message).toBe("original verification failure");
  const other = { ...saved, runId: "other-run", status: "completed" as const };
  await delivery.store(base, saved.runId).save(other);
  expect((await base.load(other.runId))?.status).toBe("completed");
  expect(inspections).toBe(0);
});
