#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./cli/arguments.js";
import { applyCliProfile } from "./cli/cli-profiles.js";
import { createConfiguredHarness } from "./cli/configured-harness.js";
import { createHarnessClientAdapter } from "./client/adapter.js";
import { serveAcpStdio } from "./client/acp-stdio.js";

export const acpMain = async (argv = process.argv.slice(2)) => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write("Usage: zhx-acp --workspace /absolute/project --provider openai --model MODEL\nExperimental ACP v1 text-session subset. Credentials come from the host environment.\n");
    return;
  }
  const options = await applyCliProfile(parseCliArgs(["run", ...argv, "--json"]));
  if (options.prompt || options.serviceFile) throw new Error("ACP accepts host configuration flags, not a task or service file");
  const { harness } = await createConfiguredHarness(options);
  try {
    const adapter = await createHarnessClientAdapter(harness);
    const stop = () => process.stdin.destroy();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await serveAcpStdio(adapter, { workspace: harness.config.workspace, input: process.stdin, output: process.stdout }); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); adapter.close(); }
  } finally { await harness.close(); }
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acpMain().catch(() => { process.stderr.write("ACP service failed. Check host configuration and protocol input.\n"); process.exitCode = 1; });
}
