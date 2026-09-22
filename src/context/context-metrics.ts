import type { ModelGenerateInput } from "@zhivex-ai/core";
import { z } from "zod";

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
      counts.toolDefinitionCharacters += JSON.stringify({ name, description: definition.description,
        schema: z.toJSONSchema(definition.schema as z.ZodType) }).length;
    } catch { counts.unmeasuredToolDefinitions++; }
  }
  return counts;
};
