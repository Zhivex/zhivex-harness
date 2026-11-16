import { ValidationError, wrapLanguageModel, type LanguageModel, type StreamEvent } from "@zhivex-ai/core";

/** SDK 0.12.4 exposes thinking/signature deltas as provider-data. Reassemble the
 * signed block before it enters durable history; never replay raw delta objects. */
export async function* assembleAnthropicContinuation(events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  let pending: { type: "thinking"; thinking: string; signature: string } | undefined;
  let bytes = 0;
  const invalid = () => new ValidationError("Invalid or oversized Anthropic signed continuation block.");
  const flush = function* (): Generator<StreamEvent> {
    if (!pending) return;
    if (!pending.signature) throw invalid();
    yield { type: "provider-data", provider: "anthropic", data: pending };
    pending = undefined; bytes = 0;
  };
  for await (const event of events) {
    if (event.type === "provider-data" && event.provider === "anthropic" &&
        event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
      const data = event.data;
      if (data.type === "thinking_delta" || data.type === "signature_delta") {
        const field = data.type === "thinking_delta" ? "thinking" : "signature";
        if (!pending || typeof data[field] !== "string") throw invalid();
        bytes += Buffer.byteLength(data[field]);
        if (bytes > 1024 * 1024) throw invalid();
        pending[field] += data[field];
        continue;
      }
      if (data.type === "thinking") {
        yield* flush();
        if (typeof data.thinking !== "string" || typeof data.signature !== "string") throw invalid();
        pending = { type: "thinking", thinking: data.thinking, signature: data.signature };
        bytes = Buffer.byteLength(data.thinking) + Buffer.byteLength(data.signature);
        if (bytes > 1024 * 1024) throw invalid();
        continue;
      }
    }
    yield* flush();
    yield event;
  }
  yield* flush();
}
export const withAnthropicContinuation = (model: LanguageModel): LanguageModel => wrapLanguageModel(model, [{
  name: "harness-anthropic-signed-continuation-v1",
  wrapStream: async (_context, next) => assembleAnthropicContinuation(await next())
}]);
