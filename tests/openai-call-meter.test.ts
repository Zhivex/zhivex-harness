import { expect, test } from "bun:test";
import { createOpenAICallMeter } from "../scripts/benchmarks/openai-call-meter.js";
import { gradeReasoningAnswer } from "../scripts/benchmarks/reasoning-fixtures.js";

const body = (effort?: string) => JSON.stringify({ model: "gpt-6-luna", max_output_tokens: 1024, ...(effort ? { reasoning: { effort } } : {}) });
const terminal = { type: "response.completed", response: { model: "gpt-6-luna", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } } } };
test("per-call meter handles fragmented UTF-8, milestones, duplicate terminals and detached numeric records", async () => {
  let clock = 0;
  const text = [{ type: "response.output_item.added", item: { type: "reasoning" } }, { type: "response.function_call_arguments.delta", delta: "PRIVATE" },
    { type: "response.output_text.delta", delta: "PRIVATE á" }, terminal, terminal].map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const fake = (async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }))) as unknown as typeof fetch;
  const meter = createOpenAICallMeter(fake, "low", () => clock++); meter.start();
  const response = await meter.fetch("https://api.openai.com/v1/responses", { body: body("low"), method: "POST" });
  expect(await response.text()).toBe(text);
  const call = meter.snapshot()[0]!;
  expect(call).toMatchObject({ index: 1, requestedEffort: "low", usage: { totalTokens: 15, reasoningTokens: 2 }, duplicateTerminals: 1, interrupted: false });
  expect(call.firstReasoningEventMs!).toBeLessThan(call.firstToolEventMs!);
  expect(call.firstToolEventMs!).toBeLessThan(call.firstTextMs!);
  expect(call.firstTextMs!).toBeLessThan(call.terminalMs!);
  expect(JSON.stringify(call)).not.toContain("PRIVATE");
  call.usage!.totalTokens = 999; expect(meter.snapshot()[0]!.usage!.totalTokens).toBe(15);
  await expect(meter.fetch("https://api.openai.com/v1/responses", { body: body("low") })).rejects.toThrow("retry");
});

test("effort mismatch and absent token caps reject before network; omitted effort remains default", async () => {
  let calls = 0;
  const fake = (async () => { calls++; return new Response(`data: ${JSON.stringify(terminal)}`); }) as unknown as typeof fetch;
  const meter = createOpenAICallMeter(fake, "default");
  await expect(meter.fetch("https://api.openai.com/v1/responses", { body: body("low") })).rejects.toThrow("assignment");
  await expect(meter.fetch("https://api.openai.com/v1/responses", { body: JSON.stringify({ model: "gpt-6-luna" }) })).rejects.toThrow("cap");
  expect(calls).toBe(0);
  await (await meter.fetch("https://api.openai.com/v1/responses", { body: body() })).text();
  expect(meter.snapshot()[0]).toMatchObject({ requestedEffort: "omitted", usage: { totalTokens: 15 } });
});

test("incomplete responses retain usage and broken streams retain an unmetered call", async () => {
  const incomplete = { ...terminal, type: "response.incomplete" };
  const meter = createOpenAICallMeter((async () => new Response(`data: ${JSON.stringify(incomplete)}\n\n`)) as unknown as typeof fetch, "low");
  await (await meter.fetch("https://api.openai.com/v1/responses", { body: body("low") })).text();
  expect(meter.snapshot()[0]).toMatchObject({ terminalType: "response.incomplete", usage: { totalTokens: 15 } });
  const broken = createOpenAICallMeter((async () => new Response(new ReadableStream({ start(c) { c.error(new Error("network")); } }))) as unknown as typeof fetch, "low");
  await expect((await broken.fetch("https://api.openai.com/v1/responses", { body: body("low") })).text()).rejects.toThrow("network");
  expect(broken.snapshot()[0]).toMatchObject({ interrupted: true });
  expect(broken.snapshot()[0]!.usage).toBeUndefined();
});

test("quality checks reject wrong answers even with well-formed, long JSON", () => {
  const explanation = Array(85).fill("word").join(" ");
  expect(gradeReasoningAnswer("arithmetic", JSON.stringify({ available: 9, reorder: true, explanation })).pass).toBe(true);
  expect(gradeReasoningAnswer("arithmetic", JSON.stringify({ available: 11, reorder: false, explanation })).facts).toBe(false);
  expect(gradeReasoningAnswer("code-review", JSON.stringify({ bug: "NO_BUG", replacement: "return true;", cases: [true, true, true], explanation })).facts).toBe(false);
  expect(gradeReasoningAnswer("facts", JSON.stringify({ alpha: "apples", beta: "bananas", explanation: "short" }))).toMatchObject({ facts: true, length: false, pass: false });
});

test('experimental 4096 cap isolates cache keys without editing prompts and records exhaustion', async () => {
  const sent: any[] = [];
  const fake = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response('data: '+JSON.stringify({type:'response.incomplete',response:{model:'gpt-6-luna',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:50,output_tokens:4096,total_tokens:4146,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:4096}}}})+'\n\n'); }) as unknown as typeof fetch;
  const meter=createOpenAICallMeter(fake,'default',()=>1,4096,true);
  for (const input of ['task one','task two']) {
    const response=await meter.fetch('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({model:'gpt-6-luna',max_output_tokens:4096,input})});
    await response.text();
  }
  expect(sent[0].input).toBe('task one');expect(sent[0].prompt_cache_key).not.toBe(sent[1].prompt_cache_key);
  expect(meter.snapshot()[0]).toMatchObject({maxOutputTokens:4096,cachedUsageReported:true,incompleteReason:'max_output_tokens'});
  expect(meter.snapshot()[0]!.cacheKeyHash).not.toBe(meter.snapshot()[1]!.cacheKeyHash);
});
