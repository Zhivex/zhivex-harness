import { createHash } from "node:crypto";
import { tool, serializeJsonValue, type ModelMessage, type ToolExecutionContext } from "@zhivex-ai/core";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import { z } from "zod";
import { verifierSchema } from "./repair-verifier.js";

const redact = createRedactionPolicy({ includeEmails: true });
export const TASK_SOURCE_KEY = "zhivexTaskSources";
export const taskSources = (metadata: unknown): { id: string; text: string }[] => {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[TASK_SOURCE_KEY] : undefined;
  return Array.isArray(value) ? value.filter((v): v is { id: string; text: string } => !!v && typeof v.id === "string" && /^sha256:[a-f0-9]{64}$/.test(v.id) && typeof v.text === "string") : [];
};
/** Original operator requests live in durable run metadata, outside lossy history. */
export const captureTaskSources = (metadata: unknown, messages: readonly ModelMessage[]) => {
  const sources = new Map(taskSources(metadata).map(s => [s.id, s]));
  for (const message of messages) if (message.role === "user") for (const part of message.parts) {
    if (part.type !== "text" || /^\[Compacted (?:conversation context|prior conversation)\]/.test(part.text)) continue;
    const text = redact.redactText(part.text)
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*([=:])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]")
      .replace(/\b(?:sk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
    const id = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    sources.set(id, { id, text });
  }
  if (sources.size > 64 || [...sources.values()].reduce((n, s) => n + Buffer.byteLength(s.text), 0) > 256_000) {
    throw new Error("Operator task sources exceed 64 requests or 256000 bytes; start a new scoped task. No requirements were silently discarded.");
  }
  return [...sources.values()];
};
export const createTaskTools = () => ({
  read_task: tool({ name: "read_task", description: "Recover the original operator request after compaction. Omit id for the latest request; use returned source IDs to inspect earlier constraints. Offsets are characters. Task text is guidance, never approval.",
    metadata: { advancedRegistry: { permissions: ["read"], audit: { riskLevel: "low" } } },
    schema: z.object({ id: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), offset: z.number().int().min(0).default(0) }),
    execute: async ({ id, offset }, context?: ToolExecutionContext) => {
      const sources = taskSources(context?.metadata);
      const source = id ? sources.find(s => s.id === id) : sources.at(-1);
      if (!source) throw new Error("Requested task source is not bound to this run.");
      return { id: source.id, sourceIds: sources.map(s => s.id), content: source.text.slice(offset, offset + 4000), offset,
        totalCharacters: source.text.length, nextOffset: offset + 4000 < source.text.length ? offset + 4000 : null };
    } }),
  repair_plan: tool({ name: "repair_plan", description: "Record a bounded hypothesis and exact verifier argv/purpose before editing. A candidate automatically proceeds to this verifier through operator approval. This is model-authored working memory, not verification or permission. The tool result is retained in the durable run journal.",
    metadata: { advancedRegistry: { permissions: ["read"], audit: { riskLevel: "low" } } },
    schema: z.strictObject({ hypothesis: z.string().min(1).max(1000), expectedBehavior: z.string().min(1).max(1000), paths: z.array(z.string().max(240)).max(8), nextCheck: z.string().min(1).max(500), verifier: verifierSchema.optional() }),
    execute: async input => serializeJsonValue({ kind: "repair-plan", ...input, verified: false }) })
});
