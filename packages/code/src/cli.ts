export * from "@zhivex-ai/harness/terminal";
import { runCli as sharedRunCli } from "@zhivex-ai/harness/terminal";
import { CODE_VERSION } from "./version.js";
export const runCli = (argv = process.argv.slice(2)) => sharedRunCli(argv, CODE_VERSION);

if (import.meta.main) await runCli();
