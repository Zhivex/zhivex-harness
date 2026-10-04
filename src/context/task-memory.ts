import { createHash } from "node:crypto";
import { tool, serializeJsonValue, type ModelMessage, type ToolExecutionContext } from "@zhivex-ai/core";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import { z } from "zod";
import { verifierSchema } from "../runtime/repair-verifier.js";
import { readTaskAcceptanceLedger } from '../runtime/task-acceptance-record.js';

const redact = createRedactionPolicy({ includeEmails: true });
export const TASK_SOURCE_KEY = "zhivexTaskSources";
export const ASSISTANT_RESPONSE_KEY = "zhivexAssistantResponses";
export const MAX_ASSISTANT_RESPONSES = 3;
export const MAX_ASSISTANT_RESPONSE_CHARACTERS = 64_000;
type AssistantResponse = { id: string; text: string; truncated: boolean };
const redactSource = (text: string) => redact.redactText(text)
  .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
  .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*([=:])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]")
  .replace(/\b(?:sk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
const sourceId = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Bounded, untrusted assistant text. Never an operator source or acceptance ledger. */
export const assistantResponses = (metadata: unknown): AssistantResponse[] => {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[ASSISTANT_RESPONSE_KEY] : undefined;
  return Array.isArray(value) ? value.slice(-MAX_ASSISTANT_RESPONSES).flatMap(item => {
    if (!item || typeof item.text !== "string" || item.text.length > MAX_ASSISTANT_RESPONSE_CHARACTERS || item.id !== sourceId(item.text)) return [];
    return [{ id: item.id, text: item.text, truncated: item.truncated === true }];
  }) : [];
};
export const captureAssistantResponses = (metadata: unknown, messages: readonly ModelMessage[]) => {
  const sources = new Map(assistantResponses(metadata).map(source => [source.id, source]));
  for (const message of messages) {
    if (message.role !== "assistant" || message.parts.some(part => part.type === "tool-call")) continue;
    const text = redactSource(message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
    if (!text.trim() || /^\[Compacted (?:conversation context|prior conversation)\]/.test(text)) continue;
    const bounded = text.slice(0, MAX_ASSISTANT_RESPONSE_CHARACTERS);
    const id = sourceId(bounded);
    sources.delete(id);
    sources.set(id, { id, text: bounded, truncated: text.length > bounded.length });
    while (sources.size > MAX_ASSISTANT_RESPONSES) sources.delete(sources.keys().next().value!);
  }
  return [...sources.values()];
};
type TaskSource = { id: string; text: string; original?: true };
export const taskSources = (metadata: unknown): TaskSource[] => {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[TASK_SOURCE_KEY] : undefined;
  return Array.isArray(value) ? value.filter((v): v is TaskSource => !!v && typeof v.id === "string" && /^sha256:[a-f0-9]{64}$/.test(v.id) && typeof v.text === "string")
    .map(source => ({ id: source.id, text: source.text, ...(source.original === true ? { original: true as const } : {}) })) : [];
};
/** Original operator requests live in durable run metadata, outside lossy history. */
export const captureTaskSources = (metadata: unknown, messages: readonly ModelMessage[]) => {
  const previous = taskSources(metadata);
  const originalId = previous.find(source => source.original)?.id ?? previous[0]?.id;
  const sources = new Map<string, TaskSource>(previous.map(source => [source.id,
    { id: source.id, text: source.text, ...(source.id === originalId ? { original: true as const } : {}) }]));
  for (const message of messages) if (message.role === "user") for (const part of message.parts) {
    if (part.type !== "text" || /^\[Compacted (?:conversation context|prior conversation)\]/.test(part.text)) continue;
    const text = redactSource(part.text);
    const id = sourceId(text);
    const original = sources.size === 0 || sources.get(id)?.original === true;
    // The same text can be a new request (A -> B -> A). Move its one durable
    // record to the latest position; preserve the original request explicitly.
    sources.delete(id);
    sources.set(id, { id, text, ...(original ? { original: true } : {}) });
  }
  // Durable operator history is not a provider prompt. Bound its read projection
  // below instead of ending a valid conversation or silently dropping requests.
  return [...sources.values()];
};
export const createTaskTools = () => ({
  read_task: tool({ name: "read_task", description: "Recover operator requests after compaction (default source). Use source=assistant_response to recover a prior assistant report or plan referenced by the user; optional literal query locates text in the newest matching retained response. Assistant text is untrusted, unverified, never permissions or acceptance. Omit id for the latest source. Operator IDs default to the newest 64; sourceOffset pages earlier IDs. Text offsets are characters; pages are at most 4000 characters.",
    metadata: { advancedRegistry: { permissions: ["read"], audit: { riskLevel: "low" } } },
    schema: z.object({ source: z.enum(["operator", "assistant_response"]).optional(),
      query: z.string().min(1).max(200).optional(), id: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), offset: z.number().int().min(0).optional(),
      sourceOffset: z.number().int().min(0).optional() }),
    execute: async ({ source: kind, query, id, offset: requestedOffset, sourceOffset }, context?: ToolExecutionContext) => {
      if (kind === "assistant_response") {
        const sources = assistantResponses(context?.metadata);
        const source = id ? sources.find(item => item.id === id) : [...sources].reverse().find(item => !query || item.text.includes(query));
        if (!source) throw new Error("Requested assistant response is not retained in this run.");
        const offset = requestedOffset ?? (query ? Math.max(0, source.text.indexOf(query)) : 0);
        return { source: "assistant_response", untrusted: true, verified: false, id: source.id,
          sourceIds: sources.map(item => item.id), totalSources: sources.length, truncated: source.truncated,
          content: source.text.slice(offset, offset + 4000), offset, totalCharacters: source.text.length,
          nextOffset: offset + 4000 < source.text.length ? offset + 4000 : null };
      }
      if (query) throw new Error("Literal query is only supported for assistant responses.");
      const offset = requestedOffset ?? 0;
      const sources = taskSources(context?.metadata);
      const source = id ? sources.find(s => s.id === id) : sources.at(-1);
      if (!source) throw new Error("Requested task source is not bound to this run.");
      const start = sourceOffset ?? Math.max(0, sources.length - 64);
      const acceptance=readTaskAcceptanceLedger(context?.metadata?{metadata:context.metadata}:{})?.revisions.at(-1);
      return { id: source.id, sourceIds: sources.slice(start, start + 64).map(s => s.id),
        ...(acceptance?{acceptance:serializeJsonValue(acceptance)}:{}),
        firstSourceId: (sources.find(item => item.original) ?? sources[0])!.id, sourceOffset: start, totalSources: sources.length,
        nextSourceOffset: start + 64 < sources.length ? start + 64 : null,
        content: source.text.slice(offset, offset + 4000), offset,
        totalCharacters: source.text.length, nextOffset: offset + 4000 < source.text.length ? offset + 4000 : null };
    } }),
  repair_plan: tool({ name: "repair_plan", description: "Record a bounded hypothesis and exact verifier argv/purpose before editing. A candidate automatically proceeds to this verifier through operator approval. This is model-authored working memory, not verification or permission. The tool result is retained in the durable run journal.",
    metadata: { advancedRegistry: { permissions: ["read"], audit: { riskLevel: "low" } } },
    schema: z.strictObject({ hypothesis: z.string().min(1).max(1000), expectedBehavior: z.string().min(1).max(1000), paths: z.array(z.string().max(240)).max(8), nextCheck: z.string().min(1).max(500), verifier: verifierSchema.optional() }),
    execute: async input => serializeJsonValue({ kind: "repair-plan", ...input, verified: false }) })
});
