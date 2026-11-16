import { openHarnessProjectMemory, type HarnessProjectMemoryOptions } from "./project-memory.js";
import { HarnessConfigError } from "../runtime/errors.js";

export const HARNESS_MEMORY_COMMANDS = ["remember", "list", "read", "update", "forget", "suggest", "accept", "clear", "enable", "disable", "context"] as const;
/** Host/CLI operations only: these commands are never added to the model tool catalog. */
export async function executeHarnessMemoryCommand(options: HarnessProjectMemoryOptions, command: string,
  args: readonly string[], source = "Explicit operator input") {
  const counts: Record<string, number> = { remember: 1, list: 0, read: 1, update: 3, forget: 2, suggest: 1,
    accept: 2, clear: 0, enable: 0, disable: 0, context: 1 };
  if (!Object.hasOwn(counts, command) || args.length !== counts[command]) throw new HarnessConfigError("Invalid memory command arguments. Use memory --help.");
  const memory = await openHarnessProjectMemory(options);
  try {
    let result: unknown;
    switch (command) {
      case "list": result = memory.list(); break;
      case "read": result = memory.read(args[0]!); break;
      case "remember": result = memory.remember({ content: args[0]!, source }); break;
      case "suggest": result = memory.suggest({ content: args[0]!, source }); break;
      case "update": result = memory.update(args[0]!, Number(args[1]), { content: args[2]!, source }); break;
      case "accept": result = memory.accept(args[0]!, Number(args[1])); break;
      case "forget": memory.forget(args[0]!, Number(args[1])); result = { forgotten: args[0] }; break;
      case "clear": result = { cleared: memory.clear() }; break;
      case "enable": case "disable": memory.setEnabled(command === "enable"); result = { enabled: command === "enable" }; break;
      case "context": result = memory.retrieve(args[0]!); break;
    }
    const view = memory.list();
    return { schemaVersion: 1, kind: "memory-command", command, workspaceKey: view.workspaceKey,
      scopeKey: view.scopeKey, result };
  } finally { memory.close(); }
}
