import { setTimeout as delay } from "node:timers/promises";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Meta can briefly reject a response ID it just emitted. Recovery is confined
// to function receipts: replaying this HTTP request cannot rerun host tools.
const isReceiptContinuation = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (init?.method !== "POST" || typeof init.body !== "string") return false;
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.endsWith("/responses")) return false;
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body)) return false;
    return typeof body.previous_response_id === "string" && body.previous_response_id.length > 0 &&
      Array.isArray(body.input) && body.input.length > 0 &&
      body.input.every((item: unknown) => isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string" && typeof item.output === "string") &&
      Array.isArray(body.tools) && body.tools.every((tool: unknown) => isRecord(tool) && tool.type === "function");
  } catch { return false; }
};

const isUnavailableResponse = async (response: Response) => {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) return false;
      chunks.push(next.value);
    }
    const error = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    return error?.type === "invalid_request_error" && typeof error.message === "string" &&
      /response/i.test(error.message) && /not found|expired/i.test(error.message) &&
      (error.param == null || error.param === "previous_response_id");
  } catch { return false; }
  finally { void reader.cancel().catch(() => {}); }
};

export const createMetaContinuationFetch = (fetcher: typeof fetch = fetch, backoff: number | readonly number[] = [1000, 2000]): typeof fetch => {
  // The SDK's retries reuse their RequestInit. One bounded recovery sequence
  // across that entire request, even if a later 5xx triggers an SDK retry.
  const recovered = new WeakSet<RequestInit>();
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let response = await fetcher(input, init);
    if (response.status !== 400 || !init || recovered.has(init) ||
        !isReceiptContinuation(input, init) || !await isUnavailableResponse(response)) return response;
    recovered.add(init);
    for (const waitMs of typeof backoff === "number" ? [backoff] : backoff) {
      init.signal?.throwIfAborted();
      await response.body?.cancel();
      await delay(waitMs, undefined, { signal: init.signal ?? undefined });
      init.signal?.throwIfAborted();
      response = await fetcher(input, init);
      if (response.status !== 400 || !await isUnavailableResponse(response)) break;
    }
    return response;
  }, { preconnect: fetcher.preconnect });
};
