import type { ModelMessage, StreamEvent } from "@zhivex-ai/core";

type Part = ModelMessage["parts"][number];
const reasoning = (part: Part | StreamEvent): string | undefined => {
  if (part.type !== "provider-data" || part.provider !== "qwen" || !part.data ||
      typeof part.data !== "object" || Array.isArray(part.data)) return;
  if (part.data.type === "reasoning_content" && typeof part.data.reasoningContent === "string" &&
      Object.keys(part.data).every(key => ["type", "reasoningContent"].includes(key)) &&
      Object.keys(part).every(key => ["type", "provider", "data"].includes(key))) return part.data.reasoningContent;
};
const partFor = (text: string): Part & StreamEvent => ({
  type: "provider-data", provider: "qwen", data: { type: "reasoning_content", reasoningContent: text }
});

/** Lossless adjacent-fragment normalization; opaque/signed data and tool parts are barriers. */
export const normalizeQwenReasoning = (messages: readonly ModelMessage[]): ModelMessage[] => messages.map(message => {
  if (message.role !== "assistant") return message;
  const parts: Part[] = [];
  let chunks: string[] = [];
  const flush = () => { if (chunks.length) { parts.push(partFor(chunks.join(""))); chunks = []; } };
  for (const part of message.parts) {
    const text = reasoning(part);
    if (text !== undefined) chunks.push(text);
    else { flush(); parts.push(part); }
  }
  flush();
  return { ...message, parts };
});

/** Bound retained streaming fragments while leaving text/tools and their order intact. */
export async function* coalesceQwenReasoning(events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  let chunks: string[] = [], size = 0;
  try {
  for await (const event of events) {
    const text = reasoning(event);
    if (text !== undefined) {
      chunks.push(text); size += text.length;
      if (size >= 16_384) { yield partFor(chunks.join("")); chunks = []; size = 0; }
    } else {
      if (chunks.length) { yield partFor(chunks.join("")); chunks = []; size = 0; }
      yield event;
    }
  }
  } catch (error) {
    if (chunks.length) yield partFor(chunks.join(""));
    throw error;
  }
  if (chunks.length) yield partFor(chunks.join(""));
}
