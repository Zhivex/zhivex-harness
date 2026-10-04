import { executeHarnessMemoryCommand } from "../persistence/project-memory-command.js";
import { resolveHarnessConfig } from "../runtime/config.js";
import type { CliOptions } from "./arguments.js";

export async function manageMemory(options: CliOptions) {
  const document = await executeHarnessMemoryCommand(resolveHarnessConfig(options), options.memoryCommand!,
    options.memoryArguments ?? [], options.memorySource);
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}
