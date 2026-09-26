import { wrapLanguageModel, type ModelGenerateInput, type ModelMessage } from "@zhivex-ai/core";
import { createMeta, type MetaProviderOptions } from "@zhivex-ai/meta";

type ReplayItem = { type: "reasoning"; summary: []; encrypted_content: string; id?: string };

// SDK 0.2.8 retains reasoning output but does not serialize it on input.
// Let the SDK serialize all ordinary parts; insert opaque reasoning at the
// corresponding message boundary. Never decrypt, summarize, or log it.
const replayPlan = (messages: ModelMessage[]) => {
  let offset = 0;
  const insertions: { offset: number; item: ReplayItem }[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (message.role !== "assistant" || part.type !== "provider-data" || part.provider !== "meta") continue;
      const data = part.data;
      if (!data || typeof data !== "object" || Array.isArray(data) || data.type !== "reasoning" ||
          typeof data.encrypted_content !== "string" || !data.encrypted_content) continue;
      insertions.push({ offset, item: {
        type: "reasoning", summary: [], encrypted_content: data.encrypted_content,
        ...(typeof data.id === "string" ? { id: data.id } : {})
      } });
    }
    if (message.role === "tool") {
      offset += message.parts.filter(part => part.type === "tool-result").length;
    } else {
      if (message.role === "assistant") offset += message.parts.filter(part => part.type === "tool-call").length;
      if (message.parts.some(part => ["text", "image", "audio", "file"].includes(part.type))) offset++;
    }
  }
  return { insertions, itemCount: offset };
};

export const createMetaReplayModel = (options: MetaProviderOptions, modelId: string) => {
  const fetcher = options.fetch ?? fetch;
  const prepare = (input: ModelGenerateInput) => {
    const plan = replayPlan(input.messages);
    const messages = input.messages.map(message => ({ ...message, parts: message.parts.filter(part =>
      !(part.type === "provider-data" && part.provider === "meta" && part.data &&
        typeof part.data === "object" && !Array.isArray(part.data) && "responseId" in part.data)) }));
    const { previous_response_id: _previous, ...providerOptions } = input.providerOptions ?? {};
    const include = Array.isArray(providerOptions.include) ? providerOptions.include.filter((v): v is string => typeof v === "string") : [];
    // Per-invocation closure: concurrent model calls cannot share replay state.
    const replayFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Meta replay requires a serialized SDK request.");
      const body = JSON.parse(init.body);
      const items: unknown[] = body.input ?? [];
      if (!Array.isArray(items) || items.length !== plan.itemCount) throw new Error("Meta SDK input layout changed; cannot safely replay reasoning.");
      const replayed: unknown[] = [];
      let insertion = 0;
      for (let offset = 0; offset <= items.length; offset++) {
        while (plan.insertions[insertion]?.offset === offset) replayed.push(plan.insertions[insertion++]!.item);
        if (offset < items.length) replayed.push(items[offset]);
      }
      delete body.previous_response_id;
      body.input = replayed;
      return fetcher(url, { ...init, body: JSON.stringify(body) });
    }, { preconnect: fetcher.preconnect });
    return {
      model: createMeta({ ...options, fetch: replayFetch })(modelId),
      input: { ...input, messages, providerOptions: {
        ...providerOptions, apiMode: "responses" as const, store: false,
        include: [...new Set([...include, "reasoning.encrypted_content"])]
      } }
    };
  };
  return wrapLanguageModel(createMeta(options)(modelId), [{
    name: "harness-meta-stateless-replay-v1",
    async wrapGenerate({ input }) {
      const prepared = prepare(input);
      return prepared.model.generate(prepared.input);
    },
    async wrapStream({ input }) {
      const prepared = prepare(input);
      return prepared.model.stream!(prepared.input);
    }
  }]);
};
