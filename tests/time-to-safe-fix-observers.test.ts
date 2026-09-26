import { expect, test } from "bun:test";
import type { LanguageModel } from "@zhivex-ai/agents";
import { channel } from "node:diagnostics_channel";
import { observeBenchmarkFetch, observeBenchmarkModel } from "../scripts/time-to-safe-fix-model-observer.js";
import { benchmarkSnapshot, beginBenchmarkSpan, updateBenchmarkSpan, configureBenchmarkBudget, markBenchmarkTimeout } from "../scripts/time-to-safe-fix-progress.js";
import { observeOciPhase } from "../src/execution/oci-observability.js";
import { benchmarkProgressSchema } from "../src/runtime/error-diagnostics.js";

test("model attempts record HTTP status and first text latency without retaining content", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = Object.assign(async () => new Response("private body", { status: ++attempts === 1 ? 429 : 200 }), { preconnect: original.preconnect });
  const restore = observeBenchmarkFetch();
  let returned = false;
  const failure = new Error("private error");
  const model = observeBenchmarkModel({ provider: "fixture", modelId: "fixture", capabilities: {},
    generate: async () => { await fetch("https://private.invalid"); throw failure; },
    stream: async () => (async function* () {
      try {
        await fetch("https://private.invalid", { headers: { authorization: "secret" } });
        await fetch("https://private.invalid");
        yield { type: "text-delta", text: "private output" };
        yield { type: "finish", finishReason: "stop" };
      } finally { returned = true; }
    })()
  } as unknown as LanguageModel);
  try {
    const stream = await model.stream!({ messages: [] });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text-delta");
    await iterator.return!();
    expect(returned).toBe(true);
    const snapshot = benchmarkSnapshot();
    const call = snapshot.spans!.findLast(span => span.operation === "stream")!;
    expect(call.outcome).toBe("cancelled");
    expect(call.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.spans!.filter(span => span.parentId === call.id).map(span => [span.attempt, span.httpStatus])).toEqual([[1, 429], [2, 200]]);
    await expect(model.generate({ messages: [] })).rejects.toBe(failure);
    expect(benchmarkSnapshot().spans!.findLast(span => span.operation === "generate")!.outcome).toBe("failed");
    expect(JSON.stringify(benchmarkSnapshot())).not.toMatch(/private|secret|authorization/);
  } finally { restore(); globalThis.fetch = original; }
});

test("OCI records phase outcomes and tool deadline without changing results or errors", async () => {
  const events: unknown[] = [];
  const observer = (value: unknown) => events.push(value);
  const diagnostics = channel("zhivex.harness.oci.phase");
  diagnostics.subscribe(observer);
  try {
    const result = { timedOut: true, stdout: "private output" };
    expect(await observeOciPhase("oci_execute", async () => result)).toBe(result);
    const error = new Error("private path");
    await expect(observeOciPhase("oci_cleanup", async () => { throw error; })).rejects.toBe(error);
    expect(events).toMatchObject([{ operation: "oci_execute", outcome: "running" }, { operation: "oci_execute", outcome: "failed", timedOut: true }, { operation: "oci_cleanup", outcome: "running" }, { operation: "oci_cleanup", outcome: "failed" }]);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally { diagnostics.unsubscribe(observer); }
});

test("history and span retention stay bounded and preserve active operations", () => {
  configureBenchmarkBudget(300000, 270000, 10000);
  const active = beginBenchmarkSpan("stream");
  for (let i = 0; i < 50; i++) { const id = beginBenchmarkSpan("read_file"); updateBenchmarkSpan(id, { outcome: "completed" }); }
  markBenchmarkTimeout("agent");
  const snapshot = benchmarkProgressSchema.parse(benchmarkSnapshot());
  expect(snapshot.spans).toHaveLength(24);
  expect(snapshot.spans!.some(span => span.id === active && span.outcome === "running")).toBe(true);
  expect(snapshot.budget).toMatchObject({ supervisorMs: 300000, agentMs: 270000, toolMs: 10000, expired: "agent" });
  updateBenchmarkSpan(active, { outcome: "completed" });
});


test("stream failure keeps the original exception even when iterator cleanup also fails", async () => {
  const original = new Error("original-private-error");
  const model = observeBenchmarkModel({ provider: "fixture", modelId: "fixture", capabilities: {},
    stream: async () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw original; }, return: async () => { throw new Error("cleanup-private-error"); } }) })
  } as unknown as LanguageModel);
  const stream = await model.stream!({ messages: [] });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(original);
});

test("HTTP rejection survives stream error and span eviction for any model provider", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({error:{status:"INVALID_ARGUMENT",param:"tools",message:"SECRET"}}), {status:400}), {preconnect:original.preconnect});
  const restore = observeBenchmarkFetch();
  const model = observeBenchmarkModel({provider:"gemini",modelId:"fixture",capabilities:{},
    stream: async () => (async function* () { await fetch("https://private.invalid"); yield {type:"error",error:new Error("SECRET")}; })()
  } as unknown as LanguageModel);
  try {
    for await (const _ of await model.stream!({messages:[]})) { /* consume */ }
    for (let i=0;i<30;i++) { const id=beginBenchmarkSpan("oci_cleanup"); updateBenchmarkSpan(id,{outcome:"completed"}); }
    expect(benchmarkSnapshot().lastProviderFailure).toMatchObject({operation:"http",httpStatus:400,provider:{reason:"invalid_request",parameter:"tools",bodyState:"parsed"}});
    expect(JSON.stringify(benchmarkSnapshot())).not.toContain("SECRET");
  } finally {restore();globalThis.fetch=original;}
});

test("transport rejection retains the HTTP boundary and original error", async () => {
  const original = globalThis.fetch;
  const failure = new TypeError("SECRET network");
  globalThis.fetch = Object.assign(async () => {throw failure;}, {preconnect:original.preconnect});
  const restore=observeBenchmarkFetch();
  const model=observeBenchmarkModel({provider:"openai",modelId:"fixture",capabilities:{},generate:async()=>fetch("https://private.invalid")} as unknown as LanguageModel);
  try {
    await expect(model.generate({messages:[]})).rejects.toBe(failure);
    expect(benchmarkSnapshot().lastProviderFailure).toMatchObject({operation:"http",outcome:"failed",failureKind:"transport"});
    expect(benchmarkSnapshot().lastProviderFailure?.httpStatus).toBeUndefined();
  } finally {restore();globalThis.fetch=original;}
});

test("provider syntax errors are classified without exposing payload or retrying", async () => {
  let requests = 0;
  const error = new SyntaxError("private provider payload");
  const model = observeBenchmarkModel({ provider: "qwen", modelId: "fixture", capabilities: {},
    stream: async () => (async function* () { requests++; throw error; })()
  } as unknown as LanguageModel);
  const stream = await model.stream!({ messages: [] });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(error);
  expect(requests).toBe(1);
  expect(benchmarkSnapshot().spans!.findLast(span => span.operation === "stream")).toMatchObject({ outcome: "failed", failureKind: "syntax" });
  expect(JSON.stringify(benchmarkSnapshot())).not.toContain("private");
});
