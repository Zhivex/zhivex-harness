import type { LanguageModelMiddleware, ModelGenerateInput } from "@zhivex-ai/core";

/** The durable local history is authoritative. Remote response chains retain discarded
 * context and can omit newly injected instructions. Replay local messages instead;
 * retain reasoning/tool parts, including opaque provider payloads. */
const localInput = (input: ModelGenerateInput): ModelGenerateInput => {
    const { previous_response_id: _previous, ...providerOptions } = input.providerOptions ?? {};
    return { ...input, providerOptions, messages: input.messages.map(message => ({
      ...message, parts: message.parts.flatMap(part => {
        if (message.role !== "assistant" || part.type !== "provider-data" || part.provider !== "qwen" ||
            !part.data || typeof part.data !== "object" || Array.isArray(part.data) || !("responseId" in part.data)) return [part];
        const { responseId: _id, ...data } = part.data;
        return Object.keys(data).length ? [{ ...part, data }] : [];
      })
    })) };
};
export const qwenLocalContext: LanguageModelMiddleware = {
  name: "harness-qwen-local-context-v1",
  async wrapGenerate(context, next) { Object.assign(context.input, localInput(context.input)); return next(); },
  async wrapStream(context, next) { Object.assign(context.input, localInput(context.input)); return next(); }
};
