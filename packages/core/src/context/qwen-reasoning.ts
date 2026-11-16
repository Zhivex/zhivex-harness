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

// Responses emits both deltas and a final plaintext summary. Remove only an
// exact duplicate with a known unsigned shape; opaque provider data is retained.
const duplicateSummary = (part: Part | StreamEvent, text: string): boolean => {
  if (!text || part.type !== "provider-data" || part.provider !== "qwen") return false;
  const data = part.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.type !== "reasoning" ||
      !Object.keys(data).every(key => ["type", "id", "summary"].includes(key)) || !Array.isArray(data.summary)) return false;
  const chunks: string[] = [];
  for (const item of data.summary) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "summary_text" ||
        typeof item.text !== "string" || !Object.keys(item).every(key => ["type", "text"].includes(key))) return false;
    chunks.push(item.text);
  }
  return chunks.join("") === text;
};

/** Lossless adjacent-fragment normalization; opaque/signed data and tool parts are barriers. */
export const normalizeQwenReasoning = (messages: readonly ModelMessage[]): ModelMessage[] => messages.map(message => {
  if (message.role !== "assistant") return message;
  const parts: Part[] = [];
  let chunks: string[] = [];
  let seen = "";
  const flush = () => { if (chunks.length) { parts.push(partFor(chunks.join(""))); chunks = []; } };
  for (const part of message.parts) {
    const text = reasoning(part);
    if (text !== undefined) { chunks.push(text); seen += text; }
    else if (!duplicateSummary(part, seen)) { flush(); parts.push(part); seen = ""; }
  }
  flush();
  return { ...message, parts };
});

/** Bound retained streaming fragments while leaving text/tools and their order intact. */
export async function* coalesceQwenReasoning(events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  let chunks: string[] = [], size = 0;
  let seen = "";
  try {
  for await (const event of events) {
    const text = reasoning(event);
    if (text !== undefined) {
      chunks.push(text); size += text.length; seen += text;
      if (size >= 16_384) { yield partFor(chunks.join("")); chunks = []; size = 0; }
    } else if (!duplicateSummary(event, seen)) {
      if (chunks.length) { yield partFor(chunks.join("")); chunks = []; size = 0; }
      yield event;
      seen = "";
    }
  }
  } catch (error) {
    if (chunks.length) yield partFor(chunks.join(""));
    throw error;
  }
  if (chunks.length) yield partFor(chunks.join(""));
}
