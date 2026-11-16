#!/usr/bin/env node
import {observeCliPolicy} from "./cli/policy-decisions.js";
import { formatCliHelp } from "./cli/cli-help.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "./version.js";
import { harnessErrorDocument } from "./runtime/errors.js";
import { applyCliProfile, resolveCliDefaults } from "./cli/cli-profiles.js";
import { parseCliArgs } from "./cli/arguments.js";
import { annotateCliStreamError, cliStreamErrorSequence, terminalErrorMessage } from "./cli/presentation.js";
import { initializeCli, listProviders } from "./cli/setup.js";
import { CLI_FULL_HELP_TEXT } from "./cli/help-text.js";
import { inspectCliPolicy } from "./cli/policy.js";
import { doctor } from "./cli/doctor.js";
import { chat } from "./cli/console.js";
import { resumeRun, reviewOnce, runOnce } from "./cli/run-commands.js";
import { manageRuns } from "./cli/run-management.js";
import { manageSessions } from "./cli/session-management.js";
import { manageChanges } from "./cli/changes.js";
import { manageMemory } from "./cli/memory.js";
import { manageState } from "./cli/state.js";
import { manageCheckpoints } from "./cli/checkpoints.js";
import { cliExitCodeForError, cliRecoveryHint } from "./cli/errors.js";
import { readStdinTask } from "./cli/task-input.js";

export { runResultDocument } from "./cli/run-document.js";

export { CLI_JSON_SCHEMA_VERSION } from "./cli/cli-stream.js";

export const main = async (argv = process.argv.slice(2)) => {
  if (["web", "--web"].includes(argv[0] ?? "")) throw new (await import("./cli/arguments.js")).CliUsageError("Use Zhivex Electron for the desktop UI or zhx chat --area code for the shared core. The legacy browser has been removed.");
  let parsedOptions = parseCliArgs(argv);
  if ((parsedOptions.command === 'automations' && parsedOptions.automationCommand === 'apply') || (parsedOptions.command === 'connections' && parsedOptions.managementAction === 'configure') || (parsedOptions.command === 'agents' && parsedOptions.managementAction === 'tools')) {
    const text = await readStdinTask();
    try {parsedOptions.managementInput = JSON.parse(text);} catch {throw new (await import('./cli/arguments.js')).CliUsageError('Configuration input must be valid JSON.');}
    parsedOptions.managementArgs = [];
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const openConsole = interactive && !parsedOptions.json && !parsedOptions.jsonl &&
    (parsedOptions.command === "chat" ||
      (parsedOptions.command === "run" && parsedOptions.implicitCommand && !parsedOptions.prompt));
  if (openConsole) parsedOptions = { ...parsedOptions, command: "chat" };
  if ((parsedOptions.command === "run" || parsedOptions.command === "review") && parsedOptions.prompt === "-") {
    parsedOptions = { ...parsedOptions, prompt: await readStdinTask() };
  }
  if (!['help', 'version'].includes(parsedOptions.command) && (['application', 'agents', 'connections', 'projects', 'personal', 'automations'].includes(parsedOptions.command) || parsedOptions.applicationDirectory || parsedOptions.applicationArea)) {
    const {useApplicationCli} = await import('./cli/application-cli.js');
    const serviceFile = await useApplicationCli(parsedOptions);
    if (['application', 'agents', 'connections', 'projects', 'personal', 'automations'].includes(parsedOptions.command)) return;
    parsedOptions = {...parsedOptions, ...(serviceFile ? {serviceFile} : {})};
  }
  if (parsedOptions.serviceFile) {
    const { runServiceCli } = await import("./cli/service-client-cli.js");
    await runServiceCli(parsedOptions, annotateCliStreamError);
    return;
  }
  if ((parsedOptions.autoApproveMode || parsedOptions.autoApproveAllow) && ["run", "review", "resume"].includes(parsedOptions.command)) {
    const advanced = await import('./cli/interactive/run-commands.js');
    const configured = await applyCliProfile(parsedOptions);
    await (configured.command === 'run' ? advanced.runOnce(configured) : configured.command === 'review' ? advanced.reviewOnce(configured) : advanced.resumeRun(configured));
    return;
  }
  if (["chat", "doctor"].includes(parsedOptions.command) &&
      !parsedOptions.sessionId && !parsedOptions.continueSession) {
    parsedOptions = await resolveCliDefaults(parsedOptions);
  }
  if (openConsole && !parsedOptions.profile && !parsedOptions.provider && !parsedOptions.model &&
      !parsedOptions.sessionId && !parsedOptions.continueSession &&
      !process.env.ZHIVEX_HARNESS_PROVIDER && !process.env.ZHIVEX_HARNESS_MODEL) {
    process.stdout.write("First-time setup — choose your provider and model.\n");
    if (!await initializeCli({ ...parsedOptions, command: "init", profile: "default" }, { onboarding: true })) return;
    parsedOptions = { ...parsedOptions, profile: "default" };
  }
  const options = parsedOptions.command === "init"
    ? parsedOptions
    : await applyCliProfile(parsedOptions);
  switch (options.command) {
    case "init":
      await initializeCli(options);
      return;
    case "help":
      process.stdout.write(`${formatCliHelp(options.helpTopic, HARNESS_VERSION, CLI_FULL_HELP_TEXT)}\n`);
      return;
    case "version":
      process.stdout.write(`${HARNESS_VERSION}\n`);
      return;
    case "providers":
      listProviders(options.json);
      return;
    case "policy":
      await inspectCliPolicy(options);
      return;
    case "doctor":
      await doctor(options);
      return;
    case "chat":
      await observeCliPolicy(options, {}, () => chat(options));
      return;
    case "resume":
      await resumeRun(options);
      return;
    case "runs":
      await manageRuns(options);
      return;
    case "sessions":
      await manageSessions(options);
      return;
    case "checkpoints": {
      const restored = await manageCheckpoints(options);
      if (restored && interactive && !options.json) await chat({ ...options, command: 'chat', sessionId: restored.sessionId });
      return;
    }
    case "changes":
      await manageChanges(options);
      return;
    case "memory":
      await manageMemory(options);
      return;
    case "state":
      await manageState(options);
      return;
    case "export-audit":
    case "verify-audit": {
      const { auditPackCli } = await import("./cli/audit-pack.js");
      await auditPackCli(options);
      return;
    }
    case "run":
      await runOnce(options);
      return;
    case "review":
      await reviewOnce(options);
  }
};

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

export const runCli = async (argv = process.argv.slice(2)) => {
  await main(argv).catch((error: unknown) => {
    const document = harnessErrorDocument(error);
    if (argv.includes("--jsonl")) {
      process.stdout.write(`${JSON.stringify({
        ...document,
        kind: "run-stream-error",
        sequence: cliStreamErrorSequence(error)
      })}\n`);
    } else if (argv.includes("--json")) {
      process.stderr.write(`${JSON.stringify(document)}\n`);
    } else {
      process.stderr.write(`Error: ${terminalErrorMessage(error)}\n`);
      process.stderr.write(`Recovery: ${cliRecoveryHint(error, argv)}\n`);
    }
    process.exitCode = cliExitCodeForError(error);
  });
};

if (isMainModule) void runCli();

export { HARNESS_RESUME_METADATA_KEY } from "./cli/resume-metadata.js";
export { HARNESS_RESUME_METADATA_SCHEMA_VERSION } from "./cli/resume-metadata.js";
export { CLI_EXIT_CODES } from "./cli/errors.js";
export { annotateCliStreamError } from "./cli/presentation.js";
export { cliStreamErrorSequence } from "./cli/presentation.js";
export { terminalErrorMessage } from "./cli/presentation.js";
export { CLI_COMMANDS } from "./cli/arguments.js";
export { CLI_RUNS_COMMANDS } from "./cli/arguments.js";
export { CLI_SESSIONS_COMMANDS } from "./cli/arguments.js";
export { CLI_CHANGES_COMMANDS } from "./cli/arguments.js";
export { CLI_STATE_COMMANDS } from "./cli/arguments.js";
export type { CliOptions } from "./cli/arguments.js";
export { CliUsageError } from "./cli/arguments.js";
export { createHarnessResumeMetadata } from "./cli/resume-metadata.js";
export { readHarnessResumeConfig } from "./cli/resume-metadata.js";
export { readHarnessResumeRoutes } from "./cli/resume-metadata.js";
export { resumeCommand } from "./cli/resume-metadata.js";
export { parseCliArgs } from "./cli/arguments.js";
export { CLI_HELP_TEXT } from "./cli/help-text.js";
export { CLI_FULL_HELP_TEXT } from "./cli/help-text.js";
export { summarizeApproval } from "./cli/presentation.js";
export { withTemporaryHarnessProfiles } from "./cli/routing.js";
export { providersDocument } from "./cli/setup.js";
export type { DoctorCheckStatus } from "./cli/doctor.js";
export type { DoctorCheck } from "./cli/doctor.js";
export type { DoctorReport } from "./cli/doctor.js";
export type { DoctorContext } from "./cli/doctor.js";
export { createDoctorReport } from "./cli/doctor.js";
export { formatDoctorReport } from "./cli/doctor.js";
export { cliExitCodeForError } from "./cli/errors.js";
