import type { LanguageModelMiddleware, ModelMessage } from "@zhivex-ai/core";
import type { HarnessProjectMemory } from "../persistence/project-memory.js";

/** Per-request projection; memory text never enters system instructions or durable
 * run messages. Reload for every request so edits, forgetting and opt-out apply
 * even to a resumed run. Existing conversation history has its own retention. */
export function createProjectMemoryMiddleware(memory: HarnessProjectMemory): LanguageModelMiddleware {
  const prepare = (messages: ModelMessage[]) => {
    let at = messages.length - 1;
    while (at >= 0 && messages[at]!.role !== "user") at--;
    if (at < 0) return messages;
    const query = messages[at]!.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const result = memory.retrieve(query);
    if (!result.content) return messages;
    return [...messages.slice(0, at), { role: "user" as const, parts: [{ type: "text" as const, text: result.content }] }, ...messages.slice(at)];
  };
  return { name: "project-memory-context-v1",
    async wrapGenerate(context, next) { context.input.messages = prepare(context.input.messages); return next(); },
    async wrapStream(context, next) { context.input.messages = prepare(context.input.messages); return next(); }
  };
}
