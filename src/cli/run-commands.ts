import { TerminalMarkdown } from "./terminal/terminal-markdown.js";
import {
  resolveHarnessConfig,
  type HarnessConfigInput,
  type HarnessProvider,
  type HarnessSubagentProfile
} from "../runtime/config.js";
import { createHarness, runHarness } from "../runtime/harness.js";
import { openHarnessPersistence } from "../persistence/operations.js";
import { validateStateDirectory } from "../persistence/state-directory.js";
import { runHarnessReviewGroup } from "../runtime/orchestration.js";
import { createHarnessRouteModels } from "../providers/routing.js";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import { HarnessStateConflictError, harnessErrorDocument } from "../runtime/errors.js";
import { CliUsageError, type CliOptions } from "./arguments.js";
import { createConfiguredHarness } from "./configured-harness.js";
import {
  createHarnessResumeMetadata,
  harnessConfigInput,
  readHarnessResumeConfig,
  readHarnessResumeRoutes
} from "./resume-metadata.js";
import {
  annotateCliStreamError,
  approvalResponses,
  orchestrationObserver,
  printTerminalResult,
  streamSink,
  summarizeApproval,
  terminalApprovalResolver,
  terminalErrorMessage
} from "./presentation.js";
import { CLI_EXIT_CODES } from "./errors.js";
import { assertRoutePricingIsSafe } from "./routing.js";
import { updateIndexedSessionRun } from "./session-management.js";

export const runOnce = async (options: CliOptions) => {
  if (!options.prompt) {
    throw new CliUsageError("Missing task. Example: zhivex-harness run \"fix the tests\".");
  }
  const { harness, routes } = await createConfiguredHarness(options);
  const tracker: { streamedText: boolean; sequence?: number; markdown?: TerminalMarkdown } = { streamedText: false };
  let closeAttempted = false;
  try {
    const result = await runHarness(
      harness,
      {
        prompt: options.prompt,
        scope: harness.config.scope,
        metadata: createHarnessResumeMetadata(harness.config, routes),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
      },
      {
        onEvent: streamSink(options, tracker),
        resolveApprovals: terminalApprovalResolver(options.yes)
      }
    );
    closeAttempted = true;
    await harness.close();
    printTerminalResult(result, harness, options, tracker);
    if (result.status === "failed" || result.status === "timed_out") {
      process.exitCode = CLI_EXIT_CODES.runtimeError;
    }
  } catch (error) {
    if (!closeAttempted) {
      closeAttempted = true;
      await harness.close().catch(() => undefined);
    }
    tracker.markdown?.flush();
    throw options.jsonl ? annotateCliStreamError(error, tracker.sequence) : error;
  }
};

export const reviewOnce = async (options: CliOptions) => {
  if (!options.prompt) {
    throw new CliUsageError("Missing review task. Example: zhivex-harness review \"review the state boundary\".");
  }
  const requestedReviewers: HarnessSubagentProfile[] = options.reviewers ?? ["explorer", "reviewer"];
  const enabledProfiles: HarnessSubagentProfile[] = [...new Set([
    ...(options.subagentProfiles ?? []),
    ...requestedReviewers
  ])];
  const { harness } = await createConfiguredHarness(options, enabledProfiles);
  try {
    const result = await runHarnessReviewGroup(
      harness,
      { prompt: options.prompt, scope: harness.config.scope },
      requestedReviewers
    );
    const document = {
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: "review-group" as const,
      ...(result.usageLedger ? { usageLedger: result.usageLedger } : {}),
      groupId: result.groupId,
      status: result.status,
      profiles: result.profiles,
      outputs: result.outputs.map((member) => ({
        name: member.name,
        agentId: member.agentId,
        status: member.status,
        ...(member.output
          ? {
              runId: member.output.state.runId,
              runStatus: member.output.status,
              output: member.output.outputText,
              steps: member.output.steps.length,
              usage: member.output.usage
            }
          : {}),
        ...(member.error ? { error: harnessErrorDocument(member.error).error } : {})
      }))
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else {
      for (const [index, output] of document.outputs.entries()) {
        process.stdout.write(`\n[${output.name ?? output.agentId ?? "reviewer"}] ${output.status}\n`);
        if ("output" in output && output.output) process.stdout.write(`${output.output}\n`);
        const memberError = result.outputs[index]?.error;
        if (memberError) {
          process.stdout.write(`Error [${output.error?.code ?? "EXECUTION_FAILED"}]: ${terminalErrorMessage(memberError)}\n`);
        }
      }
    }
    if (result.status === "failed") {
      process.exitCode = CLI_EXIT_CODES.runtimeError;
    }
  } finally {
    await harness.close();
  }
};

export const resumeRun = async (options: CliOptions) => {
  if (!options.runId) {
    throw new CliUsageError("Missing runId to resume.");
  }
  if (options.approve === undefined) {
    throw new CliUsageError("Specify --approve or --deny when resuming.");
  }

  const initialConfig = resolveHarnessConfig(options);
  await validateStateDirectory(initialConfig.workspace, initialConfig.stateDirectory);
  const persistence = await openHarnessPersistence(initialConfig);
  let persistenceClosed = false;
  const closePersistence = () => {
    if (persistenceClosed) return;
    persistenceClosed = true;
    persistence.close();
  };
  try {
    const state = await persistence.store.load(options.runId, initialConfig.scope);
    if (!state) {
      throw new HarnessStateConflictError(`Run ${options.runId} was not found in ${initialConfig.stateDirectory}.`);
    }
    if (state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
      throw new HarnessStateConflictError(`Run ${options.runId} is not waiting for approval (status: ${state.status}).`);
    }

    for (const approval of state.pendingApprovals) {
      process.stderr.write(`\nResuming approval:\n${summarizeApproval(approval)}\n`);
    }

    const persistedResumeInput = readHarnessResumeConfig(state);
    const persistedRoutes = readHarnessResumeRoutes(state);
    let persistedResumeOptions: HarnessConfigInput = {};
    let resumeCostBudget = initialConfig.costBudget;
    if (persistedResumeInput) {
      const persistedConfig = resolveHarnessConfig(persistedResumeInput);
      if (
        persistedConfig.workspace !== initialConfig.workspace ||
        persistedConfig.stateDirectory !== initialConfig.stateDirectory ||
        persistedConfig.storeBackend !== initialConfig.storeBackend ||
        JSON.stringify(persistedConfig.scope) !== JSON.stringify(initialConfig.scope)
      ) {
        throw new HarnessStateConflictError(
          "Resume locator options do not match the persisted workspace, state directory, store, or scope."
        );
      }
      persistedResumeOptions = harnessConfigInput(persistedConfig);
      resumeCostBudget = persistedConfig.costBudget;
    }
    assertRoutePricingIsSafe(persistedRoutes, resumeCostBudget);

    const harness = await createHarness({
      ...persistedResumeOptions,
      usageAccounting: {},
      ...options,
      provider: state.provider as HarnessProvider,
      model: state.modelId,
      subagentProfiles: [...new Set([
        ...((persistedResumeOptions.subagentProfiles ?? []) as HarnessSubagentProfile[]),
        ...persistedRoutes.keys()
      ])],
      subagentModels: createHarnessRouteModels(persistedRoutes),
      store: persistence.store,
      memory: persistence.memory,
      onTelemetryEvent: orchestrationObserver(options.json || options.jsonl)
    });
    const approve = options.approve;
    const tracker: { streamedText: boolean; sequence?: number; markdown?: TerminalMarkdown } = { streamedText: false };
    let harnessCloseAttempted = false;
    try {
      const result = await runHarness(
        harness,
        {
          state,
          approvals: approvalResponses(
            state.pendingApprovals,
            approve,
            approve ? "Approved by resume --approve." : "Denied by resume --deny."
          )
        },
        {
          onEvent: streamSink(options, tracker),
          resolveApprovals: async (approvals) => approvalResponses(
            approvals,
            approve,
            approve ? "Approved by resume --approve." : "Denied by resume --deny."
          )
        }
      );
      await updateIndexedSessionRun(harness.config, result.state.runId, result.status);
      harnessCloseAttempted = true;
      await harness.close();
      closePersistence();
      printTerminalResult(result, harness, options, tracker);
      if (result.status === "failed" || result.status === "timed_out") {
        process.exitCode = CLI_EXIT_CODES.runtimeError;
      }
    } catch (error) {
      if (!harnessCloseAttempted) {
        harnessCloseAttempted = true;
        await harness.close().catch(() => undefined);
      }
      try {
        closePersistence();
      } catch {
        // Preserve the operation or first cleanup failure as the terminal cause.
      }
      tracker.markdown?.flush();
      throw options.jsonl ? annotateCliStreamError(error, tracker.sequence) : error;
    }
  } finally {
    closePersistence();
  }
};
