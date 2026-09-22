import type { ModelGenerateInput } from "@zhivex-ai/core";
import { z } from "zod";

// Zod schemas are immutable. Cache only their serialization, not mutable tool
// names/descriptions or messages. A replaced schema gets a fresh entry.
const schemaJson = new WeakMap<object, string>();
const serializeSchema = (schema: z.ZodType) => {
  let serialized = schemaJson.get(schema);
  if (serialized === undefined) {
    serialized = JSON.stringify(z.toJSONSchema(schema));
    schemaJson.set(schema, serialized);
  }
  return serialized;
};

/** Shared conservative heuristic; not a tokenizer or billing guarantee. */
export const estimateContextTokens = (counts: ReturnType<typeof measureContext>) => {
  if (counts.unmeasuredToolDefinitions) throw new Error("CONTEXT_ESTIMATE_UNAVAILABLE");
  return Math.ceil((counts.systemCharacters + counts.userCharacters + counts.assistantCharacters +
    counts.toolResultCharacters + counts.otherMessageCharacters + counts.toolDefinitionCharacters) / 3) + 64;
};

/** Provider-neutral serialized character counts, not billed tokens or wire bytes. */
export const measureContext = (input: ModelGenerateInput) => {
  const counts = { systemCharacters: 0, userCharacters: 0, assistantCharacters: 0, toolResultCharacters: 0,
    otherMessageCharacters: 0, toolDefinitionCharacters: 0, unmeasuredToolDefinitions: 0 };
  for (const message of input.messages) {
    const size = JSON.stringify(message).length;
    if (message.role === "system") counts.systemCharacters += size;
    else if (message.role === "user") counts.userCharacters += size;
    else if (message.role === "assistant") counts.assistantCharacters += size;
    else if (message.role === "tool") counts.toolResultCharacters += size;
    else counts.otherMessageCharacters += size;
  }
  for (const [name, definition] of Object.entries(input.tools ?? {})) {
    try {
      if (!("schema" in definition)) { counts.unmeasuredToolDefinitions++; continue; }
      const header = JSON.stringify({ name, description: definition.description });
      counts.toolDefinitionCharacters += header.length - 1 + ',"schema":'.length +
        serializeSchema(definition.schema as z.ZodType).length + 1;
    } catch { counts.unmeasuredToolDefinitions++; }
  }
  return counts;
};
