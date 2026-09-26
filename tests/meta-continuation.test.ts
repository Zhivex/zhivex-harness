import { describe, expect, test } from "bun:test";
import { createMetaContinuationFetch } from "../src/providers/meta-continuation.js";

const url = "https://api.meta.ai/v1/responses";
const body = { previous_response_id: "resp_recent", input: [{ type: "function_call_output", call_id: "call_1", output: "done" }], tools: [{ type: "function", name: "read_file" }] };
const request = (value: unknown = body): RequestInit => ({ method: "POST", body: JSON.stringify(value) });
const unavailable = () => Response.json({ error: { type: "invalid_request_error", message: "Response not found or expired", param: "previous_response_id" } }, { status: 400 });
const mockFetch = (fn: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(fn, { preconnect: fetch.preconnect });

describe("Meta continuation recovery", () => {
  test("allows two bounded backoffs for delayed persistence without replaying tools", async () => {
    let calls = 0;
    const init = request();
    const wrapped = createMetaContinuationFetch(mockFetch(async (_url, options) => {
      expect(options).toBe(init);
      return ++calls < 3 ? unavailable() : new Response("ok");
    }), [0, 0]);
    expect((await wrapped(url, init)).status).toBe(200);
    expect(calls).toBe(3);
  });

  test("stops after two backoffs when remote state stays unavailable", async () => {
    let calls = 0;
    const wrapped = createMetaContinuationFetch(mockFetch(async () => { calls++; return unavailable(); }), [0, 0]);
    const init = request();
    expect((await wrapped(url, init)).status).toBe(400);
    expect(calls).toBe(3);
    await wrapped(url, init);
    expect(calls).toBe(4);
  });

  test("replays identical receipt bytes and options once without consuming success stream", async () => {
    const init = request();
    let calls = 0;
    const success = new Response("stream payload");
    const wrapped = createMetaContinuationFetch(mockFetch(async (input, options) => {
      expect(input).toBe(url);
      expect(options).toBe(init);
      expect(options?.body).toBe(JSON.stringify(body));
      return ++calls === 1 ? unavailable() : success;
    }), 0);
    expect(await wrapped(url, init)).toBe(success);
    expect(success.bodyUsed).toBe(false);
    expect(calls).toBe(2);
  });

  test("limits recovery across SDK retries of the same request", async () => {
    let calls = 0;
    const wrapped = createMetaContinuationFetch(mockFetch(async () => { calls++; return unavailable(); }), 0);
    const init = request();
    expect((await wrapped(url, init)).status).toBe(400);
    expect(calls).toBe(2);
    expect((await wrapped(url, init)).status).toBe(400);
    expect(calls).toBe(3);
  });

  for (const [name, value] of Object.entries({
    initial: { ...body, previous_response_id: undefined },
    message: { ...body, input: [{ type: "message", content: "hello" }] },
    hostedTool: { ...body, tools: [{ type: "web_search" }] },
    empty: { ...body, input: [] },
    malformed: { ...body, input: [null] },
  })) test(`does not retry ${name} requests`, async () => {
    let calls = 0;
    const wrapped = createMetaContinuationFetch(mockFetch(async () => { calls++; return unavailable(); }), 0);
    await wrapped(url, request(value));
    expect(calls).toBe(1);
  });

  for (const [name, response] of Object.entries({
    schema: Response.json({ error: { type: "invalid_request_error", message: "Invalid tool schema" } }, { status: 400 }),
    otherParam: Response.json({ error: { type: "invalid_request_error", message: "Response not found", param: "model" } }, { status: 400 }),
    unauthorized: new Response("unauthorized", { status: 401 }),
    malformed: new Response("invalid json", { status: 400 }),
    oversized: new Response("x".repeat(8193), { status: 400 }),
  })) test(`preserves ${name} errors for the SDK`, async () => {
    let calls = 0;
    const original = await response.clone().text();
    const wrapped = createMetaContinuationFetch(mockFetch(async () => { calls++; return response; }), 0);
    expect(await wrapped(url, request())).toBe(response);
    expect(await response.text()).toBe(original);
    expect(calls).toBe(1);
  });

  test("does not recover unrelated endpoints or HTTP methods", async () => {
    let calls = 0;
    const wrapped = createMetaContinuationFetch(mockFetch(async () => { calls++; return unavailable(); }), 0);
    await wrapped("https://api.meta.ai/v1/chat/completions", request());
    await wrapped(url, { ...request(), method: "GET" });
    expect(calls).toBe(2);
  });

  test("abort during backoff prevents recovery request", async () => {
    const controller = new AbortController();
    let calls = 0;
    const wrapped = createMetaContinuationFetch(mockFetch(async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return unavailable();
    }), 1000);
    await expect(wrapped(url, { ...request(), signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
