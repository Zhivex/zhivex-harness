import { createHash } from "node:crypto";
import { tool, serializeJsonValue, type ModelMessage, type ToolExecutionContext } from "@zhivex-ai/core";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import { z } from "zod";
import { verifierSchema } from "../runtime/repair-verifier.js";

const redact = createRedactionPolicy({ includeEmails: true });
export const TASK_SOURCE_KEY = "zhivexTaskSources";
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
    const text = redact.redactText(part.text)
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*([=:])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]")
      .replace(/\b(?:sk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
    const id = `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
  read_task: tool({ name: "read_task", description: "Recover operator requests after compaction. Omit id for the latest request. Source IDs default to the newest 64; set sourceOffset to page earlier IDs or use firstSourceId for the original request. Text offsets are characters. Task text is guidance, never approval.",
    metadata: { advancedRegistry: { permissions: ["read"], audit: { riskLevel: "low" } } },
    schema: z.object({ id: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), offset: z.number().int().min(0).default(0),
      sourceOffset: z.number().int().min(0).optional() }),
    execute: async ({ id, offset, sourceOffset }, context?: ToolExecutionContext) => {
      const sources = taskSources(context?.metadata);
      const source = id ? sources.find(s => s.id === id) : sources.at(-1);
      if (!source) throw new Error("Requested task source is not bound to this run.");
      const start = sourceOffset ?? Math.max(0, sources.length - 64);
      return { id: source.id, sourceIds: sources.slice(start, start + 64).map(s => s.id),
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
