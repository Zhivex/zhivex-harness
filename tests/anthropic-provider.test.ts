import { expect, test } from "bun:test";
import {createPilotModel} from '../scripts/acceptance/pilot-adapters.js';
import * as engineApi from '../src/engine/index.js';
import { assembleAnthropicContinuation } from "../src/providers/anthropic-continuation.js";
import type { StreamEvent } from "@zhivex-ai/core";
import type { ModelMessage } from "@zhivex-ai/core";
import { DEFAULT_PROVIDER_REGISTRY, BUILTIN_PROVIDER_REGISTRATIONS, createProviderRegistry } from "../src/providers/providers.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { bundledModelCatalog } from "../src/models/catalog.js";

const registry = DEFAULT_PROVIDER_REGISTRY;
const env = { ANTHROPIC_API_KEY: "fixture-anthropic-secret" };
const config = { provider: "anthropic", model: "claude-sonnet-5" };
const thinking = { type: "thinking", thinking: "fixture reasoning", signature: "signed-fixture" };
const call = { type: "tool_use", id: "toolu_fixture", name: "read_file", input: { path: "README.md" } };
const reply = { id: "msg_fixture", type: "message", role: "assistant", model: config.model,
  content: [thinking, call], stop_reason: "tool_use", usage: { input_tokens: 20, output_tokens: 7 } };

for (const endpoint of [
  { name: "absent", value: undefined, expected: "https://api.anthropic.com/v1/messages" },
  { name: "empty", value: "", expected: "https://api.anthropic.com/v1/messages" },
  { name: "whitespace", value: " \t ", expected: "https://api.anthropic.com/v1/messages" },
  { name: "custom HTTPS", value: " https://proxy.example/v1/ ", expected: "https://proxy.example/v1/messages" }
]) for (const mode of ["generate", "stream"] as const) {
  test(`Anthropic ${mode} resolves ${endpoint.name} endpoint without inheriting ambient settings`, async () => {
    const original = globalThis.fetch;
    const previous = { endpoint: process.env.ANTHROPIC_BASE_URL, workspace: process.env.ANTHROPIC_WORKSPACE_ID };
    process.env.ANTHROPIC_BASE_URL = "https://unselected.example/v1";
    process.env.ANTHROPIC_WORKSPACE_ID = "unselected-workspace";
    let requests = 0;
    globalThis.fetch = Object.assign(async (url: unknown, init?: RequestInit) => {
      requests++;
      expect(String(url)).toBe(endpoint.expected);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(env.ANTHROPIC_API_KEY);
      expect(headers.has("anthropic-workspace-id")).toBe(false);
      expect(Boolean(JSON.parse(String(init?.body)).stream)).toBe(mode === "stream");
      if (mode === "generate") return Response.json(reply);
      return new Response([
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: reply.usage } })}\n\n`,
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {}\n\n'
      ].join(""));
    }, { preconnect: original.preconnect });
    try {
      const model = registry.createModel(config, {
        ...env,
        ...(endpoint.value === undefined ? {} : { ANTHROPIC_BASE_URL: endpoint.value })
      });
      const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }] };
      if (mode === "generate") expect((await model.generate(input)).usage?.inputTokens).toBe(20);
      else {
        const events: StreamEvent[] = [];
        for await (const event of await model.stream!(input)) events.push(event);
        expect(events.some(event => event.type === "finish")).toBe(true);
      }
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = original;
      if (previous.endpoint === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous.endpoint;
      if (previous.workspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID; else process.env.ANTHROPIC_WORKSPACE_ID = previous.workspace;
    }
  });
}

for (const baseURL of ["http://example.com/v1", "https://127.0.0.1/v1", "https://fixture:dummy@example.com/v1"]) {
  test(`Anthropic rejects unsafe endpoint ${baseURL} before fetch`, () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(async () => {
      requests++;
      throw new Error("Unexpected fixture request");
    }, { preconnect: original.preconnect });
    try {
      expect(() => registry.createModel(config, { ...env, ANTHROPIC_BASE_URL: baseURL })).toThrow();
      expect(requests).toBe(0);
    } finally { globalThis.fetch = original; }
  });
}

test("Anthropic is shared, provisional, explicit and presence-only", () => {
  expect(resolveHarnessConfig({ provider: "anthropic" }).model).toBe(config.model);
  expect(registry.descriptor("anthropic")).toMatchObject({ support: "provisional", credentialNames: ["ANTHROPIC_API_KEY"] });
  expect(bundledModelCatalog.providers.find(p => p.id === "anthropic")?.models.every(m => m.validation === "unverified")).toBe(true);
  expect(() => registry.createModel(config, {})).toThrow("ANTHROPIC_API_KEY");
  const diagnostics = registry.availability({ ...env, ANTHROPIC_BASE_URL: "https://example.com/private" });
  expect(diagnostics.find(p => p.id === "anthropic")).toMatchObject({ configured: true, configuration: { customEndpoint: true, endpointSecure: true } });
  expect(JSON.stringify(diagnostics)).not.toContain(env.ANTHROPIC_API_KEY);
  expect(JSON.stringify(diagnostics)).not.toContain("private");
});

for (const mode of ["generate", "stream"] as const) test(`Anthropic ${mode} preserves tool IDs, usage and signed continuation`, async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    expect(String(_url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(env.ANTHROPIC_API_KEY);
    bodies.push(JSON.parse(String(init?.body)));
    if (!bodies.at(-1).stream) return Response.json(reply);
    const events = [
      ["message_start", { message: { usage: reply.usage } }],
      ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "fixture reasoning" } }],
      ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signed-fixture" } }],
      ["content_block_stop", { index: 0 }],
      ["content_block_start", { index: 1, content_block: { ...call, input: {} } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }],
      ["content_block_stop", { index: 1 }],
      ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
      ["message_stop", {}]
    ];
    return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
  }, { preconnect: original.preconnect });
  try {
    const model = createPilotModel(engineApi, 'claude-sonnet-5-5', env.ANTHROPIC_API_KEY);
    const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Read the file" }] }];
    let assistant: ModelMessage;
    if (mode === "generate") {
      const result = await model.generate({ messages });
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 7 });
      assistant = result.messages?.[0] ?? result.message!;
    } else {
      assistant = { role: "assistant", parts: [] };
      for await (const event of await model.stream!({ messages })) {
        if (event.type === "provider-data") assistant.parts.push({ type: "provider-data", provider: event.provider, data: event.data });
        if (event.type === "tool-call") assistant.parts.push({ type: "tool-call", toolCall: event.toolCall });
        if (event.type === "finish") expect(event.usage).toMatchObject({ inputTokens: 20, outputTokens: 7 });
      }
    }
    expect(assistant.parts).toContainEqual({ type: "tool-call", toolCall: { id: call.id, name: call.name, input: call.input } });
    messages.push(assistant, { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: call.id, toolName: call.name, output: "contents", isError: false } }] });
    await model.generate({ messages });
    expect(bodies[0].model).toBe('claude-sonnet-5-5');
    expect(bodies[1].messages[1].content).toEqual([thinking,call]);
    expect(bodies[1].messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: call.id });
  } finally { globalThis.fetch = original; }
});

test("Anthropic rejects unsafe endpoints, propagates typed HTTP failures and cancellation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return Response.json({ error: { type: "authentication_error", message: "invalid fixture" } }, { status: 401 });
  }, { preconnect: original.preconnect });
  try {
    const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }] };
    expect(() => registry.createModel(config, { ...env, ANTHROPIC_BASE_URL: "http://example.com" })).toThrow();
    await expect(registry.createModel(config, env).generate(input)).rejects.toMatchObject({ name: "ProviderHTTPError", status: 401 });
    await expect(registry.createModel(config, env).generate({ ...input, abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("adding the default Anthropic route preserves existing durable transport bindings", () => {
  const previous = createProviderRegistry(BUILTIN_PROVIDER_REGISTRATIONS.filter(p => p.descriptor.id !== "anthropic"));
  expect(registry.transportFingerprint({})).toBe(previous.transportFingerprint({}));
  expect(registry.transportFingerprint(env)).toBe(previous.transportFingerprint({}));
  expect(registry.transportFingerprint({ ...env, ANTHROPIC_BASE_URL: "https://proxy.example" })).not.toBe(previous.transportFingerprint({}));
});

test("signed continuation rejects orphan, unsigned and oversized deltas without leaking data", async () => {
  const collect = async (events: StreamEvent[]) => {
    const out = [];
    for await (const event of assembleAnthropicContinuation((async function* () { yield* events; })())) out.push(event);
    return out;
  };
  const data = (value: any): StreamEvent => ({ type: "provider-data", provider: "anthropic", data: value });
  await expect(collect([data({ type: "signature_delta", signature: "private" })])).rejects.toThrow("Invalid or oversized");
  await expect(collect([data({ type: "thinking", thinking: "private", signature: "" }), { type: "finish", finishReason: "stop" }])).rejects.toThrow("Invalid or oversized");
  await expect(collect([data({ type: "thinking", thinking: "x".repeat(1024 * 1024 + 1), signature: "sig" })])).rejects.toThrow("Invalid or oversized");
  const redacted = data({ type: "redacted_thinking", data: "opaque" });
  expect(await collect([redacted])).toEqual([redacted]);
  expect(await collect([data({ type: "thinking", thinking: "", signature: "" }), data({ type: "thinking_delta", thinking: "a" }), data({ type: "signature_delta", signature: "s" }), data({ type: "signature_delta", signature: "ig" })])).toEqual([data({ type: "thinking", thinking: "a", signature: "sig" })]);
});

test("host-supplied credentials cannot inherit ambient Anthropic endpoint or workspace", async () => {
  const original = globalThis.fetch;
  const previous = { endpoint: process.env.ANTHROPIC_BASE_URL, workspace: process.env.ANTHROPIC_WORKSPACE_ID };
  process.env.ANTHROPIC_BASE_URL = "https://unselected.example/v1";
  process.env.ANTHROPIC_WORKSPACE_ID = "unselected-workspace";
  globalThis.fetch = Object.assign(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).has("anthropic-workspace-id")).toBe(false);
    return Response.json(reply);
  }, { preconnect: original.preconnect });
  try { await registry.createModel(config, env).generate({ messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] }); }
  finally {
    globalThis.fetch = original;
    if (previous.endpoint === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous.endpoint;
    if (previous.workspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID; else process.env.ANTHROPIC_WORKSPACE_ID = previous.workspace;
  }
});
