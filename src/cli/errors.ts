import { HarnessConfigError } from "../runtime/errors.js";
import { CliUsageError } from "./arguments.js";

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
