import type { LanguageModelMiddleware, ModelGenerateInput } from "@zhivex-ai/core";
import { LOCAL_TOOL_NAMES } from "../../src/tools/tool-registry.js";

/** Observe the adapter boundary, after outer policy middleware. Never retain
 * messages, schemas, arguments, external names or provider payloads. */
export const createCatalogObserver = (registeredNames: readonly string[]) => {
  const registered = new Set(registeredNames);
  const records: { call: number; offered: string[]; unknownOffered: number;
    systemMessages: number; choice: string; returned: { name: string; offered: boolean; registered: boolean }[];
    omittedReturned: number; completed: boolean }[] = [];
  let calls = 0;
  const begin = (input: ModelGenerateInput) => {
    calls++;
    if (records.length >= 100) return undefined;
    const offered = new Set(Object.keys(input.tools ?? {}));
    const choice = input.toolChoice;
    const row = { call: calls, offered: [...offered].filter(name => LOCAL_TOOL_NAMES.has(name)).sort(),
      unknownOffered: [...offered].filter(name => !LOCAL_TOOL_NAMES.has(name)).length,
      systemMessages: input.messages.filter(message => message.role === "system").length,
      choice: typeof choice === "string" && ["auto", "none", "required"].includes(choice) ? choice :
        choice && typeof choice === "object" ? "named" : "default",
      returned: [] as { name: string; offered: boolean; registered: boolean }[], omittedReturned: 0, completed: false };
    records.push(row);
    return { row, observe(name: string) {
      if (row.returned.length >= 64) { row.omittedReturned++; return; }
      row.returned.push({ name: LOCAL_TOOL_NAMES.has(name) ? name : "other-tool",
        offered: offered.has(name), registered: registered.has(name) });
    } };
  };
  const middleware: LanguageModelMiddleware = {
    name: "swebench-catalog-observer",
    async wrapGenerate(context, next) {
      const observation = begin(context.input);
      const result = await next();
      for (const message of result.messages ?? (result.message ? [result.message] : [])) {
        for (const part of message.parts) if (part.type === "tool-call") observation?.observe(part.toolCall.name);
      }
      if (observation) observation.row.completed = true;
      return result;
    },
    async wrapStream(context, next) {
      const observation = begin(context.input);
      const stream = await next();
      return (async function* () {
        for await (const event of stream) {
          if (event.type === "tool-call") observation?.observe(event.toolCall.name);
          yield event;
        }
        if (observation) observation.row.completed = true;
      })();
    }
  };
  return { middleware, snapshot: () => ({ records: structuredClone(records), omittedCalls: calls - records.length }) };
};
