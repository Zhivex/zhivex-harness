import { CredentialSetupError } from "./cli-credentials.js";
import { HarnessConfigError, HarnessError } from "@zhivex-ai/harness/engine";
import { CliUsageError, CLI_COMMANDS } from "./arguments.js";

export const cliRecoveryHint = (error: unknown, argv: string[]): string => {
  if (error instanceof CredentialSetupError) return "Run zhivex-code again to retry key setup or choose temporary use. For automation, configure the selected provider environment key.";
  if (error instanceof CliUsageError) {
    const command = argv[0];
    const topic = CLI_COMMANDS.includes(command as typeof CLI_COMMANDS[number]) && command !== "help" ? ` ${command}` : "";
    return `Use zhivex-code${topic} --help for syntax and examples.`;
  }
  if (error instanceof HarnessConfigError) {
    if (error.message.startsWith("CLI profile")) return "Use zhivex-code init --profile <name> to create a profile, or zhivex-code init --profile <name> --update to change one. Check the profile path and owner-only permissions shown above.";
    return "Run zhivex-code doctor with the same profile and workspace to diagnose configuration.";
  }
  if (error instanceof HarnessError) {
    if (error.category === "provider") return "Check the selected provider/model and credentials; use /credentials in the console or environment keys in automation.";
    if (error.category === "workspace") return "Check the workspace path and file permissions with zhivex-code doctor --workspace <path>.";
    if (error.category === "state" || error.category === "approval") return "Use zhivex-code runs list and zhivex-code runs inspect <runId> with the same workspace/state scope before resuming pending work.";
  }
  return "Inspect persisted runs with zhivex-code runs list before retrying; run zhivex-code doctor with the same configuration.";
};

export const CLI_EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  doctorFailed: 3
} as const;

export const cliExitCodeForError = (error: unknown) =>
  error instanceof CliUsageError || error instanceof HarnessConfigError
    ? CLI_EXIT_CODES.usageError
    : CLI_EXIT_CODES.runtimeError;
