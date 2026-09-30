import type { AgentRunInput, ModelMessage } from "@zhivex-ai/core";

/** Host instructions belong in the leading system section. Appending them after
 * tool results is rejected by transports with constrained system-turn placement. */
export const withRuntimeInstruction = (messages: readonly ModelMessage[], text: string): ModelMessage[] => {
  const firstConversation = messages.findIndex(message => message.role !== "system");
  const at = firstConversation === -1 ? messages.length : firstConversation;
  return [...messages.slice(0, at), { role: "system", parts: [{ type: "text", text }] }, ...messages.slice(at)];
};

/** SDK memory is inserted after its first system message. Lift a leading text
 * system section into that message before a fresh run, so memory cannot split
 * host instructions. Opaque blocks and intentional later system turns stay put. */
export const withFreshSystemInstructions = (input: AgentRunInput, hostInstructions?: string): AgentRunInput => {
  if ("state" in input || !input.messages?.length) return input;
  const firstConversation = input.messages.findIndex(message => message.role !== "system");
  const count = firstConversation === -1 ? input.messages.length : firstConversation;
  const leading = input.messages.slice(0, count);
  if (!count || leading.some(message => message.parts.some(part => part.type !== "text"))) return input;
  let text = leading.flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n\n");
  // The SDK prepends these same instructions again. Remove only an exact
  // current prefix; preserve operator additions and changed historical policy.
  const known = hostInstructions?.trim();
  if (known && (text === known || text.startsWith(known + "\n\n"))) text = text.slice(known.length).replace(/^\n\n/, "");
  return { ...input, system: [input.system, text].filter(value => value !== undefined && value !== "").join("\n\n"), messages: input.messages.slice(count) };
};
