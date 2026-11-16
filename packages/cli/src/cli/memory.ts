import * as engine from "@zhivex-ai/harness/engine";
import type { CliOptions } from "./arguments.js";
import { CliUsageError } from "./arguments.js";

export async function manageMemory(options: CliOptions) {
  // Keep existing Code commands loadable with the published engine baseline.
  // The experimental memory feature requires a matched next-version engine.
  const command = (engine as typeof engine & { executeHarnessMemoryCommand?: (
    options: ReturnType<typeof engine.resolveHarnessConfig>, command: string, args: readonly string[], source?: string
  ) => Promise<unknown> }).executeHarnessMemoryCommand;
  if (!command) throw new CliUsageError("Project memory requires the matched next-version Harness engine. See the project memory migration guide.");
  const document = await command(engine.resolveHarnessConfig(options), options.memoryCommand!,
    options.memoryArguments ?? [], options.memorySource);
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}
