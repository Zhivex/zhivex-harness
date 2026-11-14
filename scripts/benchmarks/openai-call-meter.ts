import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export interface CallUsage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; reasoningTokens: number }
export interface MeasuredCall {
  index: number; startMs: number; requestBytes: number; requestedEffort: string; maxOutputTokens: number;
  headersMs?: number; firstEventMs?: number; firstReasoningEventMs?: number; firstTextMs?: number; firstToolEventMs?: number;
  terminalMs?: number; streamEndMs?: number; terminalType?: string; returnedModel?: string; httpStatus?: number;
  wireFormat?: string; schemaHash?: string; cacheKeyHash?: string; cachedUsageReported?: boolean; incompleteReason?: string; usage?: CallUsage; interrupted?: boolean; duplicateTerminals: number; returnedEffort?: string;
}
/** Experimental benchmark instrumentation. Never stores request bodies, headers,
 * response text or reasoning. Stream times include downstream backpressure. */
export function createOpenAICallMeter(nativeFetch: typeof fetch, effort: "default" | "low", now = () => performance.now(), maxOutputTokens = 1024, coldCache = false, maxCalls = 3, expectedFormat?: { mode: "text" | "json_schema"; schemaHash?: string }) {
  assert(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 3);
  assert([1024, 2048, 4096].includes(maxOutputTokens), "Unsupported experimental response cap");
  let origin = now();
  const calls: MeasuredCall[] = [], bodies = new Set<string>();
  const measuredFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(new URL(url).hostname, "api.openai.com");
    assert.equal(typeof init?.body, "string");
    const body = init!.body as string, hash = createHash("sha256").update(body).digest("hex");
    assert(!bodies.has(hash), "Transport retry refused");
    assert(calls.length < maxCalls && Buffer.byteLength(body) <= 32_768, "Request budget exhausted");
    const payload = JSON.parse(body);
    assert(payload.model === "gpt-6-luna", "Unexpected model");
    assert(payload.max_output_tokens === maxOutputTokens, "Missing response cap");
    assert.equal(payload.reasoning?.effort, effort === "low" ? "low" : undefined, "Reasoning effort differs from assignment");
    const format = payload.text?.format;
    if (expectedFormat?.mode === "text") assert(!format || format.type === "text", "Unexpected constrained format in control");
    if (expectedFormat?.mode === "json_schema") {
      assert(format?.type === "json_schema" && format.strict === true, "Missing strict native JSON Schema");
      assert.equal(createHash("sha256").update(JSON.stringify(format.schema)).digest("hex"), expectedFormat.schemaHash, "Output schema differs from assignment");
    }
    bodies.add(hash);
    // Experimental cache isolation; never alters production provider defaults or prompt content.
    let requestInit = init;
    let cacheKeyHash: string | undefined;
    if (coldCache) {
      const key = `harness-cold-${randomUUID()}`;
      payload.prompt_cache_key = key;
      cacheKeyHash = createHash("sha256").update(key).digest("hex");
      requestInit = { ...init, body: JSON.stringify(payload) };
    }
    const started = now();
    const call: MeasuredCall = { ...(expectedFormat ? { wireFormat: format?.type ?? "text", ...(format?.schema ? { schemaHash: createHash("sha256").update(JSON.stringify(format.schema)).digest("hex") } : {}) } : {}), index: calls.length + 1, startMs: started - origin, requestBytes: Buffer.byteLength(requestInit!.body as string), ...(cacheKeyHash ? { cacheKeyHash } : {}),
      requestedEffort: payload.reasoning?.effort ?? "omitted", maxOutputTokens: payload.max_output_tokens, duplicateTerminals: 0 };
    calls.push(call);
    try {
      const response = await nativeFetch(input, requestInit);
      call.headersMs = now() - started; call.httpStatus = response.status;
      if (!response.body) { call.interrupted = true; return response; }
      let pending = "";
      const decoder = new TextDecoder();
      const line = (text: string) => {
        if (!text.startsWith("data:")) return;
        const data = text.slice(5).trim();
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data), elapsed = now() - started;
        call.firstEventMs ??= elapsed;
        if (event.type?.startsWith("response.reasoning") || event.item?.type === "reasoning") call.firstReasoningEventMs ??= elapsed;
        if (event.type === "response.output_text.delta") call.firstTextMs ??= elapsed;
        if (event.type?.startsWith("response.function_call") || event.item?.type === "function_call") call.firstToolEventMs ??= elapsed;
        if (!["response.completed", "response.failed", "response.incomplete"].includes(event.type)) return;
        if (call.terminalType) { call.duplicateTerminals++; return; }
        call.terminalMs = elapsed; call.terminalType = event.type;
        const model = event.response?.model;
        if (typeof model === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(model)) call.returnedModel = model;
        const returnedEffort = event.response?.reasoning?.effort;
        if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(returnedEffort)) call.returnedEffort = returnedEffort;
        const reason = event.response?.incomplete_details?.reason;
        if (typeof reason === "string" && /^[a-z_]{1,80}$/.test(reason)) call.incompleteReason = reason;
        const u = event.response?.usage;
        call.cachedUsageReported = Number.isSafeInteger(u?.input_tokens_details?.cached_tokens) && u.input_tokens_details.cached_tokens >= 0;
        const values = [u?.input_tokens, u?.output_tokens, u?.total_tokens];
        if (values.every(value => Number.isSafeInteger(value) && value >= 0)) call.usage = {
          inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens,
          cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0 };
      };
      const chunks = async function* () {
        try {
          for await (const chunk of response.body!) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split("\n"); pending = lines.pop()!;
            assert(pending.length < 128 * 1024 && lines.every(value => value.length < 128 * 1024), "SSE limit");
            for (const value of lines) line(value);
            yield chunk;
          }
          pending += decoder.decode(); if (pending.trim()) line(pending);
        } finally { call.streamEndMs = now() - started; call.interrupted = !call.terminalType; }
      };
      const iterator = chunks();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } },
        async cancel() { await iterator.return(undefined); }
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { call.interrupted = true; call.streamEndMs = now() - started; throw error; }
  }) as typeof fetch;
  return { fetch: measuredFetch, start: () => { assert.equal(calls.length, 0); origin = now(); }, snapshot: () => structuredClone(calls) };
}
