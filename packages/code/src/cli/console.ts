import { runHarnessTask as runHarness } from '@zhivex-ai/harness/code-support';
import { approvalFileDiff } from "./terminal/file-diff.js";
import { handleConsoleCheckpoint } from "./console/console-checkpoints.js";
import { CODE_TASK_KEY, codeTaskPrompt, freshCodeTaskBudgetRecap, freshCodeTaskRecap, keepCodeTask, prepareCodeTask, restoredCodeTask, recoverCodeTask, reviseCodeTask, type CodeTask } from "./console/console-task.js";
import { consoleWorkspaceDiff } from "./console/console-diff.js";
import { handleConsoleBudget } from "./console/console-pricing.js";
import { consoleRunPolicyMetadata, restoreConsoleRunPolicy } from "./console/console-run-policy.js";
import { ActivityHistory, formatAppliedFiles } from "./terminal/activity-history.js";
import { chooseReasoning } from "./console/console-reasoning.js";
import { reasoningEffortSchema } from "@zhivex-ai/harness/code-support";
import { cliToolExecution } from "./tool-execution.js";
import { terminalContinuationMessages } from "./terminal/terminal-continuation.js";
import { consoleProgressGuard } from "./console/console-progress.js";
import { consoleBudgetOptions, restoreConsoleOptions, formatConsoleBudget } from "./console/console-budget.js";
import { CliCredentials, credentialModel } from "./cli-credentials.js";
import { USAGE_LEDGER_KEY, createTaskTelemetry, formatUsageLedger, inspectUsageLedger, estimateMessages, persistHarnessTaskDraft, readHarnessTaskDraft } from "@zhivex-ai/harness/code-support";
import { TASK_SOURCE_KEY, taskSources } from "@zhivex-ai/harness/code-support";
import { TerminalMarkdown } from "./terminal/terminal-markdown.js";
import { navigateConsole } from "./console/console-navigation.js";
import { formatConsoleHelp } from "./console/console-commands.js";
import { formatConsoleWelcome } from "./console/console-welcome.js";
import { ConsoleInput } from "./console/console-input.js";
import { ConsoleRunView } from "./console/console-run-view.js";
import { formatConsoleOutcome } from "./console/console-outcome.js";
import { checkpointRecovery } from "./console/console-recovery.js";
import type { ConsoleComposerInput } from "./console/console-presentation.js";
import { ConsoleAttachments, formatConsoleContext } from "./console/console-context.js";
import { sanitizeTerminalText, terminalRunFailure } from "./terminal/terminal-ui.js";
import { randomUUID } from "node:crypto";
import { type AgentApprovalResponse, type AgentRunOutput } from "@zhivex-ai/agents";
import { DEFAULT_PROVIDER_REGISTRY, HARNESS_SUBAGENT_PROFILES, PROVIDERS, parseProvider, providerAvailability, providerDescriptor, resolveHarnessConfig, type HarnessSubagentProfile } from "@zhivex-ai/harness/engine";
import { appendUserMessage, compactHarnessMessages, type ZhivexHarness } from "@zhivex-ai/harness/engine";
import { openHarnessPersistence } from "@zhivex-ai/harness/engine";
import { runHarnessReviewGroup } from "@zhivex-ai/harness/engine";
import { CODE_VERSION } from "../version.js";
import { parseHarnessModelRoute, resolveHarnessModelRoutes, serializeHarnessModelRoutes, type HarnessModelRoute } from "@zhivex-ai/harness/engine";
import { type CliSession } from "@zhivex-ai/harness/engine";
import { terminalSupportsColor } from "./terminal/terminal-ui.js";
import { HarnessStateConflictError } from "@zhivex-ai/harness/engine";
import { type CliOptions } from "./arguments.js";
import { openSessionStoreForConfig, sessionStatus } from "./session-management.js";
import { resolvedRouting, withTemporaryHarnessProfiles } from "./routing.js";
import {
  createHarnessResumeMetadata,
  persistedCliOptions,
  readHarnessResumeConfig,
  readHarnessResumeRoutes
} from "./resume-metadata.js";
import { createConfiguredHarness } from "./configured-harness.js";
import {
  flushToolActivity,
  approvalResponses,
  streamSink,
  terminalApprovalResolver,
  terminalErrorMessage
} from "./presentation.js";

export const chat = async (options: CliOptions) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Chat mode requires an interactive terminal. Use run for automation.");
  }
  options = consoleBudgetOptions(options);
  const baseConfig = resolveHarnessConfig(options);
  const sessionStore = await openSessionStoreForConfig(baseConfig);
  const readline = new ConsoleInput(process.stdin, process.stdout);
  const attachments = new ConsoleAttachments();
  const activityHistory = new ActivityHistory();
  const credentials = { store: new CliCredentials(), input: readline };
  let credentialsRevision = credentials.store.revision;
  let activeController: AbortController | undefined;
  let runView: ConsoleRunView | undefined;
  const interrupt = () => {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
      process.stderr.write("\nCancellation requested locally; waiting for durable state and native cleanup. Provider stop is unconfirmed.\n");
    }
  };
  readline.onInterrupt = interrupt;
  process.on("SIGINT", interrupt);
  const abortable = async <T>(operation: (signal: AbortSignal) => Promise<T>, phase?: string): Promise<T> => {
    const controller = new AbortController();
    activeController = controller;
    readline.startBackground();
    runView?.begin(phase);
    try { return await operation(controller.signal); }
    finally { runView?.end(); readline.stopBackground(); activeController = undefined; requestInFlight = false; }
  };
  let verbose = false;
  const sessionGrants = new Set<string>();
  let runtimeOptions: CliOptions = { ...options };
  let routes = resolvedRouting(options);
  const selectedSession = options.sessionId
    ? await sessionStore.get(options.sessionId)
    : options.continueSession
      ? await sessionStore.latest()
      : undefined;
  if (options.sessionId && !selectedSession) {
    sessionStore.close();
    process.off("SIGINT", interrupt);
    readline.close();
    throw new HarnessStateConflictError(`Session ${options.sessionId} was not found.`);
  }
  let session: CliSession = selectedSession ?? await sessionStore.create();
  let messages: AgentRunOutput["messages"] = [];
  let retainedTasks: ReturnType<typeof taskSources> = [];
  let codeTask: CodeTask | undefined;
  // Carry only opaque engine-owned assistant context from this validated session.
  let retainedResponses: NonNullable<AgentRunOutput["state"]["metadata"]>[string] = [];

  let persistenceHarness: ZhivexHarness | undefined;
  const latestState = async (selected: CliSession) => {
    const latest = selected.runs.at(-1);
    if (!latest) return undefined;
    const reusable = persistenceHarness &&
      persistenceHarness.config.workspace === baseConfig.workspace &&
      persistenceHarness.config.stateDirectory === baseConfig.stateDirectory &&
      persistenceHarness.config.storeBackend === baseConfig.storeBackend &&
      persistenceHarness.config.scope.tenantId === baseConfig.scope.tenantId &&
      persistenceHarness.config.scope.userId === baseConfig.scope.userId &&
      persistenceHarness.config.scope.namespace === baseConfig.scope.namespace
      ? persistenceHarness : undefined;
    const persistence = reusable ? undefined : await openHarnessPersistence(baseConfig);
    try {
      const state = await (reusable?.store ?? persistence!.store).load(latest.runId, baseConfig.scope);
      if (!state && latest.status === 'failed') {
        process.stderr.write(`Run ${sanitizeTerminalText(latest.runId)} has no durable checkpoint. Inspect the admission error; no effects are retried automatically. Use /new for a fresh conversation.\n`);
        return undefined;
      }
      if (!state) throw new HarnessStateConflictError(`Run ${latest.runId} referenced by session ${selected.sessionId} was not found.`);
      return state;
    } finally {
      persistence?.close();
    }
  };

  const restorableState = async (selected: CliSession) => {
    const latest = await latestState(selected);
    if (latest || selected.runs.at(-1)?.status !== "failed") return latest;
    // Failed admission can precede a new run checkpoint. Preserve the task's
    // prior durable identity and context; the failed session entry stays failed.
    const persistence = await openHarnessPersistence(baseConfig);
    try {
      for (const run of selected.runs.slice(0, -1).reverse()) {
        const state = await persistence.store.load(run.runId, baseConfig.scope);
        if (state) return restoredCodeTask(state) ? state : undefined;
      }
      return undefined;
    } finally { persistence.close(); }
  };

  const sessionTaskDraft = async (selected: CliSession) => {
    const persistence = await openHarnessPersistence(baseConfig);
    try {
      const draft = await readHarnessTaskDraft(persistence.store, baseConfig.scope, selected.sessionId);
      return draft === undefined ? undefined : restoredCodeTask({ metadata: { [CODE_TASK_KEY]: JSON.parse(JSON.stringify(draft)) } });
    } finally { persistence.close(); }
  };

  let harness: ZhivexHarness;
  try {
    const restored = await restorableState(session);
    if (restored) {
      const persisted = readHarnessResumeConfig(restored);
      runtimeOptions = restoreConsoleOptions(runtimeOptions, {
        ...persistedCliOptions(persisted), provider: restored.provider, model: restored.modelId
      });
      runtimeOptions = restoreConsoleRunPolicy(runtimeOptions, restored);
      routes = readHarnessResumeRoutes(restored);
      messages = restored.messages;
      retainedTasks = taskSources(restored.metadata);
      retainedResponses = restored.metadata?.zhivexAssistantResponses ?? [];
      codeTask = restoredCodeTask(restored);
    }
    codeTask = await sessionTaskDraft(session) ?? codeTask;
    if (codeTask?.budgetVersion === 1) runtimeOptions = { ...runtimeOptions, unlimitedTokens: false };
    harness = (await createConfiguredHarness(runtimeOptions, [], routes, credentials)).harness;
    persistenceHarness = harness;
    if (codeTask) codeTask = await recoverCodeTask(harness, codeTask);
    credentialsRevision = credentials.store.revision;
  } catch (error) {
    process.off("SIGINT", interrupt);
    readline.close();
    sessionStore.close();
    throw error;
  }

  let displayLedger = inspectUsageLedger((await latestState(session))?.metadata?.[USAGE_LEDGER_KEY]);
  let requestInFlight = false;
  let contextTokens = estimateMessages(messages);
  let rejectedDecisions = 0;
  let consoleIssue: string | undefined;
  const composerState = (): ConsoleComposerInput => ({
    model: `${harness.config.provider}/${harness.config.model}`,
    reasoning: harness.config.reasoningEffort ?? "default",
    ...(session.title ? {title: session.title} : {}),
    status: session.runs.at(-1)?.status === "waiting_approval" ? "approval pending · /pending" : consoleIssue ?? "ready",
    attachments: attachments.list().length,
    automaticApprovals: options.yes === true,
    ...(options.approvalMode ? {approvalMode: options.approvalMode} : {}),
    ...(displayLedger ? {runUsage: requestInFlight ? {...displayLedger, estimatedUsd: null, usageComplete: false} : displayLedger} : {}),
    nextLimitUsd: runtimeOptions.usageLimitUsd ?? null,
    contextTokens,
  });
  runView = new ConsoleRunView(process.stdout, composerState, () => readline.backgroundStatus);

  let reviewRestored = false;
  const reviewProjectLabel = () => {
    const home = process.env.HOME;
    const workspace = harness.config.workspace;
    const project = home && (workspace === home || workspace.startsWith(`${home}/`))
      ? `~${workspace.slice(home.length)}` : workspace;
    return `${project} · ${harness.config.provider}/${harness.config.model}`;
  };
  const consoleApprovals: ReturnType<typeof terminalApprovalResolver> = async (approvals, context) => {
    runView.end();
    readline.stopBackground();
    try {
      const decisions = await terminalApprovalResolver(options.approvalMode ?? options.yes,
        question => readline.question(question), {
          select: (title, items) => readline.select(title, items),
          review: (review, items) => readline.review({...review, headerRight: review.headerRight ?? reviewProjectLabel()}, items),
          workspace: harness.config.workspace, sessionGrants,
          fileDiff: approval => approvalFileDiff(harness.workspace, approval),
          restored: reviewRestored,
          projectLabel: reviewProjectLabel(),
        })(approvals, context);
      rejectedDecisions += decisions?.filter(item => !item.approve).length ?? 0;
      if (decisions) process.stderr.write(`Approval decisions: ${decisions.filter(item => item.approve).length} allowed · ${decisions.filter(item => !item.approve).length} rejected\n`);
      else process.stderr.write("Approval pending · no decisions submitted · /pending to inspect\n");
      return decisions;
    } finally { if (activeController && !activeController.signal.aborted) { readline.startBackground(); runView.resume(); } }
  };

  const createTracker = (runId: string) => {
    const rendering = createTaskTelemetry();
    let offset = harness.workspace.mutationAudit().length;
    const initialOffset = offset;
    rejectedDecisions = 0;
    displayLedger = inspectUsageLedger(harness.usageLedger?.summary(runId));
    const tracker: Parameters<typeof streamSink>[1] = {streamedText: false,
      markdown: new TerminalMarkdown(text => {
        rendering.measure("render", () => process.stdout.write(text));
        if (text) rendering.mark("first-visible-text");
      }, terminalSupportsColor(Boolean(process.stdout.isTTY)), () => process.stdout.columns || 80),
      activityHistory, inputStatus: () => readline.backgroundStatus, consoleView: true};
    return {tracker, onTaskTelemetry: (snapshot: ReturnType<typeof rendering.snapshot>) => {
      rendering.finish();
      if (verbose) process.stderr.write(JSON.stringify({ taskTelemetry: snapshot, terminalTelemetry: rendering.snapshot() }) + "\n");
    }, outcome: (result: AgentRunOutput) => formatConsoleOutcome(result,
      harness.workspace.mutationAudit().length - initialOffset, rejectedDecisions),
      onEvent: async (event: Parameters<ReturnType<typeof streamSink>>[0]) => {
      if (event.type === "agent-step-start") requestInFlight = true;
      if (event.type === "agent-step-finish" || event.type === "agent-run-finish") requestInFlight = false;
      if (event.type === "agent-step-finish" || event.type === "agent-run-finish") displayLedger = inspectUsageLedger(harness.usageLedger?.summary(runId));
      if (event.type === "agent-run-finish") contextTokens = estimateMessages(event.state.messages);
      runView.observe(event);
      await rendering.measure("render", () => streamSink({json: false, jsonl: false}, tracker, !verbose)(event));
      if (event.type === "tool-result") {
        const audit = harness.workspace.mutationAudit();
        const receipt = formatAppliedFiles(audit.slice(offset));
        offset = audit.length;
        if (receipt) {
          flushToolActivity(tracker);
          tracker.markdown?.flush();
          process.stderr.write(receipt);
          activityHistory.add(receipt.trim());
        }
      }
    }};
  };

  const refreshSession = async () => {
    const refreshed = await sessionStore.get(session.sessionId);
    if (!refreshed) throw new HarnessStateConflictError(`Session ${session.sessionId} was not found.`);
    session = refreshed;
    return session;
  };

  const hasActiveTurn = async () => {
    const current = await refreshSession();
    let latest = current.runs.at(-1);
    if (latest) {
      const state = await latestState(current);
      if (state) {
        const durableStatus = sessionStatus(state.status);
        if (latest.status !== durableStatus) {
          session = await sessionStore.updateRun(session.sessionId, latest.runId, { status: durableStatus });
          latest = session.runs.at(-1);
        }
      }
    }
    return latest && !["completed", "failed", "cancelled", "timed_out"].includes(latest.status)
      ? latest
      : undefined;
  };

  const replaceHarness = async (
    nextOptions: CliOptions,
    nextRoutes: ReadonlyMap<HarnessSubagentProfile, HarnessModelRoute>,
    extraProfiles: readonly HarnessSubagentProfile[] = []
  ) => {
    const created = await createConfiguredHarness(nextOptions, extraProfiles, nextRoutes, credentials);
    await harness.close();
    harness = created.harness;
    persistenceHarness = harness;
    if (codeTask) codeTask = await recoverCodeTask(harness, codeTask);
    credentialsRevision = credentials.store.revision;
    runtimeOptions = nextOptions;
    routes = new Map(nextRoutes);
  };

  const withTemporaryProfiles = async <T>(
    profiles: readonly HarnessSubagentProfile[],
    operation: () => Promise<T>
  ) => {
    const normalOptions = runtimeOptions;
    const normalRoutes = new Map(routes);
    return withTemporaryHarnessProfiles(
      profiles,
      (temporaryProfiles) => replaceHarness(normalOptions, normalRoutes, temporaryProfiles),
      operation
    );
  };

  const restoreSession = async (selected: CliSession) => {
    const state = await restorableState(selected);
    const persisted = state ? readHarnessResumeConfig(state) : undefined;
    let nextOptions = state
      ? restoreConsoleRunPolicy(restoreConsoleOptions(runtimeOptions, { ...persistedCliOptions(persisted), provider: state.provider, model: state.modelId }), state)
      : runtimeOptions;
    const nextRoutes = state ? readHarnessResumeRoutes(state) : resolveHarnessModelRoutes();
    const draft = await sessionTaskDraft(selected);
    const task = draft ?? restoredCodeTask(state);
    await replaceHarness(nextOptions, nextRoutes);
    session = selected;
    attachments.clear();
    readline.clearHistory();
    activityHistory.clear();
    messages = state?.messages ?? [];
    retainedTasks = taskSources(state?.metadata);
    retainedResponses = state?.metadata?.zhivexAssistantResponses ?? [];
    codeTask = task ? await recoverCodeTask(harness, task) : undefined;
    displayLedger = inspectUsageLedger(state?.metadata?.[USAGE_LEDGER_KEY]);
    contextTokens = estimateMessages(messages);
  };

  const continuePendingApproval = async (approve: boolean, supplied?: readonly AgentApprovalResponse[]) => {
    const current = await refreshSession();
    const state = await latestState(current);
    if (!state || state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
      process.stderr.write("The current session has no pending approval.\n");
      return;
    }
    const decisions = supplied ?? approvalResponses(
      state.pendingApprovals,
      approve,
      approve ? "Approved inline in chat." : "Denied inline in chat."
    );
    const { tracker, onEvent, onTaskTelemetry, outcome } = createTracker(state.runId);
    if (!approve) rejectedDecisions += state.pendingApprovals.length;
    session = await sessionStore.updateRun(session.sessionId, state.runId, { status: "running" });
    let result: AgentRunOutput;
    try {
      result = await abortable((abortSignal) => runHarness(
        harness,
        {
          state,
          toolExecution: { ...cliToolExecution },
          abortSignal,
          approvals: [...decisions]
        },
        {
          onEvent,
          onTaskTelemetry,
          resolveApprovals: consoleApprovals
        }
      ));
    } catch {
      flushToolActivity(tracker);
      tracker.markdown?.flush();
      const durable = await latestState(await refreshSession());
      displayLedger = inspectUsageLedger(durable?.metadata?.[USAGE_LEDGER_KEY]);
      if (durable) { messages = durable.messages; retainedTasks = taskSources(durable.metadata); retainedResponses = durable.metadata?.zhivexAssistantResponses ?? []; }
      session = await sessionStore.updateRun(session.sessionId, state.runId, {
        status: durable ? sessionStatus(durable.status) : "failed"
      });
      process.stderr.write(
        approve
          ? `Run ${state.runId} failed while applying the approval; inspect /status and /activity before /pending.\n`
          : `Run ${state.runId} ended after the denial.\n`
      );
      return;
    }
    flushToolActivity(tracker);
    tracker.markdown?.flush();
    if (!tracker.streamedText && result.outputText) process.stdout.write(sanitizeTerminalText(result.outputText));
    if (result.outputText || tracker.streamedText) process.stdout.write("\n");
    messages = result.messages;
    displayLedger = inspectUsageLedger(result.state.metadata?.[USAGE_LEDGER_KEY]);
    contextTokens = estimateMessages(messages);
    process.stderr.write(outcome(result) + "\n");
    process.stderr.write(await freshCodeTaskRecap(harness, result.state));
    codeTask = restoredCodeTask(result.state);
    process.stderr.write(formatUsageLedger(result.state.metadata?.[USAGE_LEDGER_KEY]) + "\n");
    retainedTasks = taskSources(result.state.metadata);
    retainedResponses = result.state.metadata?.zhivexAssistantResponses ?? [];
    session = await sessionStore.updateRun(session.sessionId, state.runId, {
      status: sessionStatus(result.status)
    });
    if (result.status === "waiting_approval") {
      process.stderr.write(`Run ${state.runId} requires another decision; use /pending, /approve, or /deny.\n`);
    }
  };

  const statusLine = async () => {
    await hasActiveTurn();
    const current = await refreshSession();
    const latest = current.runs.at(-1);
    const failedState = latest?.status === "failed" ? await latestState(current) : undefined;
    const routeText = routes.size === 0
      ? "default"
      : [...routes.values()].map((route) => `${route.profile}=${route.provider}:${route.model}`).join(", ");
    return `session ${current.sessionId} · ${harness.config.provider}/${harness.config.model}` +
      ` · steps ${harness.config.maxSteps} · approvals ${options.approvalMode ?? (options.yes ? "auto" : "ask")} · ${messages.length} messages · routes ${routeText}` +
      `${latest ? ` · last ${latest.runId} (${latest.status})` : ""}` +
      (failedState ? `\nLast failure: ${terminalRunFailure(failedState.error)} (${failedState.currentStep}/${failedState.maxSteps} steps).` : "");
  };

  process.stderr.write(formatConsoleWelcome({
    version: CODE_VERSION,
    workspace: harness.config.workspace,
    provider: harness.config.provider,
    model: harness.config.model,
    sessionId: session.sessionId,
    ...(session.title ? { sessionTitle: session.title } : {}),
  }, { color: terminalSupportsColor(Boolean(process.stderr.isTTY)), columns: process.stdout.columns ?? 80, compact: true }) + "\n");

  process.stderr.write(`Ready · credential: ${credentials.store.source(harness.config.provider)} · account access is not checked until your first task.\n`);
  process.stderr.write("* Context estimates retained messages only; excludes request instructions/tools. Costs are estimates, not invoices.\n");
  process.stderr.write("While working: type a draft, Enter queues the next task, Up recalls the last queued task. Ctrl+C stops and clears the queue.\n");
  process.stderr.write(options.approvalMode === "restricted" ? "Restricted mode: additional approvals are denied.\n" : options.yes ? "Automatic approvals are enabled within workspace and execution policies.\n" : "Changes require your approval.\n");

  const showSessionState = async (restored = false) => {
    await hasActiveTurn();
    const state = await latestState(await refreshSession());
    if (!state) {
      if (codeTask) process.stderr.write(`Task: ${sanitizeTerminalText(codeTask.goal)}\n` + await freshCodeTaskBudgetRecap(harness, codeTask));
      return;
    }
    if (state.status === "waiting_approval" && state.pendingApprovals.length > 0) {
      reviewRestored = restored;
      try {
        const decisions = await consoleApprovals(state.pendingApprovals, state);
        if (decisions) await continuePendingApproval(true, decisions);
      } finally { reviewRestored = false; }
      return;
    }
    process.stderr.write(`Run ${sanitizeTerminalText(state.runId)} · durable status: ${state.status}\n`);
    process.stderr.write(await freshCodeTaskRecap(harness,state));
  };

  try {
    await showSessionState(Boolean(selectedSession));
    let commandInProgress = "";
    for (;;) {
      commandInProgress = "";
      try {
        const pendingTurn = await hasActiveTurn();
        readline.setQueueEnabled(!pendingTurn);
        contextTokens = estimateMessages(messages);
        const submitted = await readline.compose(composerState());
        const literalInput = readline.lastSubmissionWasPaste || submitted.includes("\n");
        let prompt = literalInput ? submitted : submitted.trim();
        if (!prompt.trim()) {
          continue;
        }
        consoleIssue = undefined;
        let command = literalInput ? "" : prompt;
        if (["/menu", "/provider", "/providers", "/model", "/models"].includes(command)) {
          const selection = await navigateConsole(readline, {
            entry: command === "/menu" ? "menu" : command.startsWith("/provider") ? "provider" : "model",
            current: {provider:harness.config.provider,model:harness.config.model,reasoningEffort:harness.config.reasoningEffort ?? "default"},
            providers: providerAvailability(),
            sessions: async () => (await sessionStore.list({limit:200})).map(item => ({value:item.sessionId,label:item.title??"Untitled conversation",detail:item.sessionId})),
          });
          if (!selection) continue;
          if ("command" in selection) { command = selection.command; prompt = command; }
          else {
            const active = await hasActiveTurn();
            if (active) { process.stderr.write(`Cannot switch models while run ${active.runId} is ${active.status}.\n`); continue; }
            const portableMessages = compactHarnessMessages(messages);
            await replaceHarness({...runtimeOptions,provider:parseProvider(selection.provider),model:selection.model,reasoningEffort:selection.reasoningEffort ?? "default"},routes);
            messages = portableMessages;
            process.stderr.write(`Next turn: ${selection.provider}/${selection.model} · reasoning ${selection.reasoningEffort ?? "default"}; context was compacted.\n`);
            continue;
          }
        }
        commandInProgress = command;
        if (command === "/task" || command.startsWith("/task ")) {
          if (await hasActiveTurn()) { process.stderr.write("Finish or deny pending work before reviewing or changing task requirements.\n"); continue; }
          const argument = command.slice(5).trim();
          const state = await latestState(await refreshSession());
          if (argument.startsWith("start ")) {
            if (codeTask) throw new Error("Use /task revise to correct this task, or /new for a separate task.");
            codeTask = await prepareCodeTask(harness, JSON.parse(argument.slice(6)));
            await persistHarnessTaskDraft(harness, session.sessionId, JSON.parse(JSON.stringify(codeTask)));
            process.stderr.write(`Task draft: ${sanitizeTerminalText(codeTask.goal)}\nBaseline inspected. Draft and budget authority retained; submit the task request to begin execution.\nNative checks execute approved code on this host; there is no task sandbox or automatic rollback.\n`);
            continue;
          }
          if (argument === "keep") {
            if (!state) throw new Error("Submit a task before keeping its result.");
            await keepCodeTask(harness, state, async review => {
              process.stdout.write(review);
              return (await readline.question("Type keep to record your decision for this exact snapshot: ")).trim() === "keep";
            });
            codeTask = restoredCodeTask(await latestState(await refreshSession()));
            if (codeTask) await persistHarnessTaskDraft(harness, session.sessionId, JSON.parse(JSON.stringify(codeTask)));
            process.stderr.write("Task decision inspected; /task review shows whether keep was recorded. Commit or export with your usual Git workflow.\n");
            continue;
          }
          if (argument.startsWith("revise ")) {
            if (!codeTask) throw new Error("Start or reopen a guided task first.");
            const correction = argument.slice(7).trim();
            if (!correction || correction.length > 500 || codeTask.constraints.length >= 8) throw new Error("A correction must be 1–500 characters; at most 8 constraints are supported.");
            codeTask = await reviseCodeTask(harness, codeTask, correction);
            prompt = correction;
            command = "";
          } else {
            if (argument && argument !== "review") { process.stderr.write('Use /task start {"goal":"...","paths":["..."],"checks":["test"],"constraints":[]} | review | keep | revise <correction>.\n'); continue; }
            process.stdout.write(await freshCodeTaskRecap(harness,state) || (codeTask ? "Task draft retained; submit the task request.\n" + await freshCodeTaskBudgetRecap(harness, codeTask) : "No guided task in this conversation. Use /task start with a goal, exact paths and package checks.\n"));
            process.stdout.write(await consoleWorkspaceDiff(harness.workspace));
            continue;
          }
        }
        if (await handleConsoleCheckpoint(command, { workspace: harness.workspace, sessions: sessionStore,
          session: await refreshSession(), input: readline, hasActiveTurn, restoreSession })) continue;
        if (await handleConsoleBudget(command, { options: runtimeOptions, provider: harness.config.provider,
          guidedTask: Boolean(codeTask),
          model: harness.config.model, input: readline, hasActiveTurn,
          replaceOptions: async next => {
            await replaceHarness(next, routes);
            if (codeTask) process.stderr.write("The current task retains its original budget authority across turns, corrections and restarts. This setting applies to future tasks; use /new to start one.\n");
          } })) continue;
        if (await handleConsoleCompaction(command, { config: harness.config, options: runtimeOptions,
          hasActiveTurn, replaceOptions: next => replaceHarness(next, routes),
          inspectCredential: provider => credentials.store.inspect(provider) })) continue;
        if (command === "/limits" || command.startsWith("/limits ")) {
          const requested = command.slice("/limits".length).trim();
          process.stderr.write(`Step limit: ${harness.config.budget.unlimitedSteps ? "none" : harness.config.maxSteps} model iterations per turn.\n`);
          if (await hasActiveTurn()) { process.stderr.write("Finish or deny pending work before changing limits.\n"); continue; }
          const next = requested || await readline.select("Step limit / Next turns", [
            { value: "", label: "Keep current limit" },
            { value: "12", label: "12 steps", detail: "Short tasks" },
            { value: "30", label: "30 steps", detail: "Medium tasks" },
            { value: "50", label: "50 steps", detail: "Long tasks; potentially higher API cost" },
          ]);
          if (!next) continue;
          if (!/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) < 1) { process.stderr.write("Use /limits with a positive safe integer step count.\n"); continue; }
          await replaceHarness({ ...runtimeOptions, maxSteps: Number(next), unlimitedSteps: false }, routes);
          process.stderr.write(`Step limit updated: ${harness.config.maxSteps} for next turns.\n`);
          if (codeTask) process.stderr.write("The current task retains its original budget authority; changing next-turn limits does not replenish it.\n");
          continue;
        }
        if (command === "/approvals" || command.startsWith("/approvals ")) {
          if (await hasActiveTurn()) { process.stderr.write("Finish or deny pending work before changing approval mode.\n"); continue; }
          const requested = command.slice("/approvals".length).trim();
          const mode = requested || await readline.select("Approval mode / This CLI session", [
            { value: "ask", label: "Ask", detail: "Review gated actions before execution" },
            { value: "auto", label: "Auto", detail: "Approve gated actions automatically; dependency reads still ask" },
            { value: "restricted", label: "Restricted", detail: "Deny actions requiring approval" },
          ]);
          if (!mode) continue;
          if (mode !== "ask" && mode !== "auto" && mode !== "restricted") { process.stderr.write("Use /approvals ask|auto|restricted.\n"); continue; }
          options.approvalMode = mode;
          options.yes = mode === "auto";
          process.stderr.write(`Approval mode: ${mode} (this CLI session).${mode === "auto" ? " Dependency reads still require permission." : ""}\n`);
          continue;
        }
        if (command === "/connection") {
          if (codeTask) {
            process.stderr.write("Connection tests are unavailable during a guided task because every model call must belong to its budget authority. Use /new for a separate connection test.\n");
            continue;
          }
          if (await hasActiveTurn()) { process.stderr.write("Finish or deny pending work before testing the connection.\n"); continue; }
          const env = await credentials.store.providerEnvironment(harness.config.provider, readline);
          process.stderr.write(`Connection: ${harness.config.provider}/${harness.config.model} · ${credentials.store.source(harness.config.provider)}\n`);
          if (harness.config.provider === "qwen") {
            // Never print arbitrary environment URLs, which may contain embedded secrets.
            process.stderr.write(`Qwen destination: ${credentials.store.destination("qwen")}\n`);
          }
          const testConnection = await readline.select("Connection / Verify model access", [
            { value: false, label: "Back without a request" },
            { value: true, label: "Send a small test request", detail: "May be billable; no workspace files or tools are sent" },
          ]);
          if (testConnection) {
            const model = await credentialModel(harness.config, env);
            await abortable(async signal => {
              await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Reply OK." }] }], maxTokens: 16,
                maxRetries: 0, timeoutMs: 15_000, abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
            }, "Testing connection");
            process.stderr.write("Connection verified: the selected model accepted a request. Tool support and other models were not tested.\n");
          }
          continue;
        }
        if (command === "/credentials") {
          const active = await hasActiveTurn();
          if (active) { process.stderr.write("Finish or deny pending work before changing credentials.\n"); continue; }
          const provider = await readline.select("Credentials / Provider", PROVIDERS.map(id => ({value:id,label:providerDescriptor(id).name})));
          if (provider) await credentials.store.configure(provider, readline);
          continue;
        }
        if (command === "/exit" || command === "/quit") {
          break;
        }
        if (command === "/verbose") {
          verbose = !verbose;
          process.stdout.write(`Activity detail: ${verbose ? "full" : "compact"}.\n`);
          continue;
        }
        if (command === "/context") {
          process.stdout.write(`${formatConsoleContext(harness.context, { attachments: attachments.list(), config: harness.config, messages })}\n`);
          continue;
        }
        if (command === "/usage") {
          const state = await latestState(await refreshSession());
          if (restoredCodeTask(state)) process.stdout.write(await freshCodeTaskRecap(harness, state));
          else if (codeTask) process.stdout.write(await freshCodeTaskBudgetRecap(harness, codeTask));
          const ledger = inspectUsageLedger(state?.metadata?.[USAGE_LEDGER_KEY]);
          const usage = ledger ? (ledger.usageComplete ? { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens,
            totalTokens: ledger.inputTokens + ledger.outputTokens } : undefined) : state?.usage;
          const saved = state ? readHarnessResumeConfig(state) : undefined;
          process.stdout.write(formatConsoleBudget(saved ? resolveHarnessConfig(saved) : harness.config, usage) + "\n");
          process.stdout.write(formatUsageLedger(ledger) + "\n");
          process.stdout.write(codeTask
            ? `Next task estimated USD limit: ${runtimeOptions.usageLimitUsd ?? "off"}. Use /budget to change future tasks. This task retains its original policy.\n`
            : `Next run estimated USD limit: ${runtimeOptions.usageLimitUsd ?? "off"}. Use /budget to change it. Pending runs retain their original policy.\n`);
          continue;
        }
        if (command === "/sessions" || command.startsWith("/sessions ")) {
          const summaries = await sessionStore.list({ search: command.slice(9).trim(), limit: 200 });
          for (const summary of summaries) {
            const selected = await sessionStore.get(summary.sessionId);
            if (!selected) continue;
            const durable = await latestState(selected);
            process.stdout.write(sanitizeTerminalText(`${summary.sessionId} · ${summary.title ?? "(untitled)"} · ${summary.runCount} runs · ${durable?.status ?? "empty"}`) + "\n");
          }
          if (!summaries.length) process.stdout.write("No sessions match in this workspace and scope.\n");
          continue;
        }
        if (command === "/attachments") {
          process.stdout.write(`${sanitizeTerminalText(JSON.stringify(attachments.list(), null, 2))}\n`);
          continue;
        }
        if (command === "/detach" || command.startsWith("/detach ")) {
          const file = prompt.slice(7).trim();
          if (file) attachments.remove(file); else attachments.clear();
          process.stderr.write("Attachment selection updated.\n");
          continue;
        }
        if (command === "/attach" || command.startsWith("/attach ")) {
          const file = prompt.slice(7).trim();
          if (!file) { process.stderr.write("Usage: /attach <workspace-relative path>\n"); continue; }
          const attached = await attachments.add(harness.workspace, file);
          process.stderr.write(`Attached ${sanitizeTerminalText(attached.path)} (${attached.startLine}-${attached.endLine}/${attached.totalLines} lines${attached.truncated ? "; excerpt" : ""}). Sent with your next task.\n`);
          continue;
        }
        if (command === "/help" || command === "/help all") {
          process.stderr.write(formatConsoleHelp("direct", command === "/help all"));
          continue;
        }
        if (command === "/clear") {
          messages = [];
          retainedTasks = [];
          retainedResponses = [];
          attachments.clear();
          readline.clearHistory();
          activityHistory.clear();
          process.stderr.write("Context cleared.\n");
          continue;
        }
        if (command === "/status") {
          process.stderr.write(`${await statusLine()}\n`);
          continue;
        }
        if (command === "/activity" || command === "/activity clear") {
          if (command.endsWith(" clear")) activityHistory.clear();
          process.stdout.write(activityHistory.render());
          continue;
        }
        if (command === "/queue clear") { readline.clearQueue(); process.stdout.write("Queued tasks and draft cleared.\n"); continue; }
        if (command === "/queue") { process.stdout.write(readline.queueSummary() + "Use /queue clear to discard queued tasks.\n"); continue; }
        if (command === "/diff") {
          process.stdout.write(await consoleWorkspaceDiff(harness.workspace, terminalSupportsColor(Boolean(process.stdout.isTTY))));
          continue;
        }
        if (command === "/compact") {
          const beforeBytes = Buffer.byteLength(JSON.stringify(messages));
          messages = compactHarnessMessages(messages);
          process.stderr.write(`Context: ${beforeBytes} -> ${Buffer.byteLength(JSON.stringify(messages))} bytes. Full task sources remain in durable memory.\n`);
          continue;
        }
        if (command === "/pending") {
          const state = await latestState(await refreshSession());
          if (!state || state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
            process.stderr.write("The current session has no pending approval.\n");
          } else await showSessionState(false);
          continue;
        }
        if (command === "/approve" || command === "/deny") {
          await continuePendingApproval(prompt === "/approve");
          continue;
        }
        if (command === "/provider" || command.startsWith("/provider ")) {
          let value = prompt.slice("/provider".length).trim();
          const active = await hasActiveTurn();
          if (active) {
            process.stderr.write(`Cannot switch provider while run ${active.runId} is ${active.status}.\n`);
            continue;
          }
          const provider = parseProvider(value);
          const model = DEFAULT_PROVIDER_REGISTRY.descriptor(provider).defaultModel;
          const portableMessages = compactHarnessMessages(messages);
          await replaceHarness({ ...runtimeOptions, provider, model, reasoningEffort: "default" }, routes);
          messages = portableMessages;
          process.stderr.write(`Next turn: ${provider}/${model}; context was compacted for a safe handoff.\n`);
          continue;
        }
        if (command === "/model" || command.startsWith("/model ")) {
          let value = prompt.slice("/model".length).trim();
          const active = await hasActiveTurn();
          if (active) {
            process.stderr.write(`Cannot switch model while run ${active.runId} is ${active.status}.\n`);
            continue;
          }
          const portableMessages = compactHarnessMessages(messages);
          const reasoningEffort = await chooseReasoning(readline, harness.config.provider, value);
          if (!reasoningEffort) continue;
          await replaceHarness({ ...runtimeOptions, model: value, reasoningEffort }, routes);
          messages = portableMessages;
          process.stderr.write(`Next turn: ${harness.config.provider}/${value}; context was compacted.\n`);
          continue;
        }
        if (command === "/reasoning" || command.startsWith("/reasoning ")) {
          const active = await hasActiveTurn();
          if (active) { process.stderr.write(`Cannot change reasoning while run ${active.runId} is ${active.status}.\n`); continue; }
          const argument = command.slice("/reasoning".length).trim();
          const effort = argument ? reasoningEffortSchema.parse(argument) : await chooseReasoning(readline, harness.config.provider, harness.config.model, harness.config.reasoningEffort);
          if (!effort) continue;
          await replaceHarness({ ...runtimeOptions, reasoningEffort: effort }, routes);
          process.stderr.write(`Reasoning for next turns: ${effort}.\n`);
          continue;
        }
        if (command === "/route" || command.startsWith("/route ")) {
          const value = prompt.slice("/route".length).trim();
          if (!value) {
            process.stderr.write(`${JSON.stringify(serializeHarnessModelRoutes(routes))}\n`);
            continue;
          }
          const active = await hasActiveTurn();
          if (active) {
            process.stderr.write(`Cannot change routes while run ${active.runId} is ${active.status}.\n`);
            continue;
          }
          const nextRoutes = new Map(routes);
          if (value === "clear") {
            nextRoutes.clear();
          } else if (value.startsWith("clear ")) {
            const profile = value.slice("clear ".length).trim() as HarnessSubagentProfile;
            if (!(HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(profile)) {
              process.stderr.write(`Unknown subagent profile: ${profile}.\n`);
              continue;
            }
            nextRoutes.delete(profile);
          } else {
            const route = parseHarnessModelRoute(value);
            nextRoutes.set(route.profile, route);
          }
          await replaceHarness(runtimeOptions, nextRoutes);
          process.stderr.write(`Routes: ${JSON.stringify(serializeHarnessModelRoutes(routes))}\n`);
          continue;
        }
        if (command === "/new" || command.startsWith("/new ")) {
          const active = await hasActiveTurn();
          if (active) {
            process.stderr.write(`Cannot leave session while run ${active.runId} is ${active.status}.\n`);
            continue;
          }
          const title = prompt.slice("/new".length).trim();
          const created = await sessionStore.create(title ? { title } : undefined);
          await restoreSession(created);
          process.stderr.write(`Created session ${session.sessionId}.\n`);
          continue;
        }
        if (command === "/rename" || command.startsWith("/rename ")) {
          const title = prompt.slice("/rename".length).trim();
          if (!title) {
            process.stderr.write("Usage: /rename <title>\n");
            continue;
          }
          session = await sessionStore.rename(session.sessionId, title);
          process.stderr.write(`Renamed session to ${session.title}.\n`);
          continue;
        }
        if (command === "/resume" || command.startsWith("/resume ")) {
          let selector = prompt.slice("/resume".length).trim();
          if (!selector) {
            const choices = await sessionStore.list({ limit: 200 });
            const choice = await readline.select("Zhivex / Conversations", choices.map(item => ({
              value: item.sessionId, label: item.title ?? "Untitled conversation", detail: `${item.sessionId} · ${item.runCount} turns`,
            })));
            if (!choice) continue;
            selector = choice;
          }
          const selected = selector === "last"
            ? await sessionStore.latest({ includeArchived: true })
            : await sessionStore.get(selector);
          if (!selected) {
            process.stderr.write(`Session ${selector} was not found.\n`);
            continue;
          }
          await restoreSession(selected);
          await showSessionState(true);
          const active = await hasActiveTurn();
          process.stderr.write(
            active
              ? `Session ${session.sessionId} has run ${active.runId} in ${active.status}; use /pending, /approve, or /deny here.\n`
              : `Resumed session ${session.sessionId}.\n`
          );
          continue;
        }
        if (command === "/review" || command.startsWith("/review ")) {
          if (codeTask) {
            if (await hasActiveTurn()) { process.stderr.write("Finish or deny pending work before reviewing the task.\n"); continue; }
            process.stdout.write(await freshCodeTaskRecap(harness, await latestState(await refreshSession())) || "Task draft retained; submit the task request.\n" + await freshCodeTaskBudgetRecap(harness, codeTask));
            process.stdout.write(await consoleWorkspaceDiff(harness.workspace));
            continue;
          }
          const reviewPrompt = prompt.slice("/review".length).trim();
          if (!reviewPrompt) {
            process.stderr.write("Usage: /review <task>\n");
            continue;
          }
          const active = await hasActiveTurn();
          if (active) {
            process.stderr.write(`Cannot start a review while run ${active.runId} is ${active.status}.\n`);
            continue;
          }
          const review = await withTemporaryProfiles(
            ["explorer", "reviewer"],
            () => abortable((abortSignal) => runHarnessReviewGroup(
              harness,
              { prompt: reviewPrompt, scope: harness.config.scope, abortSignal },
              ["explorer", "reviewer"]
            ), "Running review")
          );
          for (const output of review.outputs) {
            process.stdout.write(`\n[${output.name ?? output.agentId ?? "reviewer"}] ${output.status}\n`);
            if (output.output?.outputText) process.stdout.write(`${sanitizeTerminalText(output.output.outputText)}\n`);
          }
          continue;
        }
        const active = await hasActiveTurn();
        if (active) {
          process.stderr.write(
            `Run ${active.runId} is ${active.status}; use /pending, /approve, or /deny before a new turn.\n`
          );
          continue;
        }

        if (credentialsRevision !== credentials.store.revision) await replaceHarness(runtimeOptions, routes);
        if (!literalInput && prompt === "/continue") {
          const previous = await latestState(await refreshSession());
          if (!previous || !messages.length || previous.status === "completed") {
            process.stderr.write("No interrupted run to continue. Submit a new request.\n");
            continue;
          }
          prompt = "Continue the previous unfinished task using the retained conversation and recorded results. Inspect current state before any action whose outcome is unknown. Do not repeat completed actions. Report remaining blockers if no progress is possible.";
          process.stderr.write(codeTask
            ? "Continuing in a new run under the same task budget authority; previous results retained.\n"
            : "Continuing in a new run with the current limits; previous results retained.\n");
        } else if (!literalInput && prompt === "/paste") {
          prompt = await readline.multiline();
          if (!prompt.trim()) continue;
          process.stdout.write(`\nDraft:\n${sanitizeTerminalText(prompt)}\n`);
          // Drain the current input event before accepting a separate send decision.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if ((await readline.question("Send this draft? Type send: ")).trim() !== "send") continue;
        } else if (!literalInput && prompt.startsWith("/")) {
          process.stderr.write("Unknown command. Use /help, or /paste to send literal text starting with /.\n");
          continue;
        }
        readline.rememberPrompt(prompt, literalInput || command === "/paste");
        if (codeTask && codeTask.budgetVersion !== 1) throw new Error("This legacy task has no established task budget authority. Its saved evidence remains available for review. Use /new and /task start to establish an explicit new task before further model calls.");
        prompt = await attachments.prompt(harness.workspace, prompt);
        if (codeTask) { codeTask = { ...codeTask, keep: undefined }; prompt = codeTaskPrompt(codeTask, prompt); }
        if (codeTask) await persistHarnessTaskDraft(harness, session.sessionId, JSON.parse(JSON.stringify(codeTask)));
        const runId = `run_${randomUUID()}`;
        session = await sessionStore.appendRun(session.sessionId, {
          runId,
          provider: harness.config.provider,
          model: harness.config.model,
          status: "created"
        });
        const turn = session.runs.at(-1)!;

        const { tracker, onEvent, onTaskTelemetry, outcome } = createTracker(runId);
        const progress = consoleProgressGuard();
        let markedRunning = false;
        let result: AgentRunOutput;
        try {
          result = await abortable((abortSignal) => runHarness(
            harness,
            messages.length === 0
              ? {
                  runId,
                  toolExecution: { ...cliToolExecution },
                  abortSignal: AbortSignal.any([abortSignal, progress.signal]),
                  maxRetries: 2,
                  retryBackoffMs: 500,
                  prompt,
                  scope: harness.config.scope,
                  metadata: {
                    ...createHarnessResumeMetadata(harness.config, routes),
                    ...consoleRunPolicyMetadata(runtimeOptions),
                    ...(codeTask ? { [CODE_TASK_KEY]: JSON.parse(JSON.stringify(codeTask)) } : {}),
                    [TASK_SOURCE_KEY]: retainedTasks,
                    zhivexAssistantResponses: retainedResponses,
                    zhivexCliSession: {
                      schemaVersion: 1,
                      sessionId: session.sessionId,
                      turnId: turn.turnId,
                      sequence: turn.sequence
                    }
                  }
                }
              : {
                  runId,
                  toolExecution: { ...cliToolExecution },
                  abortSignal: AbortSignal.any([abortSignal, progress.signal]),
                  maxRetries: 2,
                  retryBackoffMs: 500,
                  messages: appendUserMessage(terminalContinuationMessages(messages), prompt),
                  scope: harness.config.scope,
                  metadata: {
                    ...createHarnessResumeMetadata(harness.config, routes),
                    ...consoleRunPolicyMetadata(runtimeOptions),
                    ...(codeTask ? { [CODE_TASK_KEY]: JSON.parse(JSON.stringify(codeTask)) } : {}),
                    [TASK_SOURCE_KEY]: retainedTasks,
                    zhivexAssistantResponses: retainedResponses,
                    zhivexCliSession: {
                      schemaVersion: 1,
                      sessionId: session.sessionId,
                      turnId: turn.turnId,
                      sequence: turn.sequence
                    }
                  }
                },
            {
              ...(codeTask ? { taskAcceptance: codeTask.contract, taskBudgetExisting: true, taskBudgetContinue: true } : {}),
              onTaskTelemetry,
              onEvent: async (event) => {
                progress.observe(event);
                if (!markedRunning && event.type === "agent-run-start") {
                  session = await sessionStore.updateRun(session.sessionId, runId, { status: "running" });
                  markedRunning = true;
                }
                await onEvent(event);
              },
              resolveApprovals: consoleApprovals
            }
          ));
        } catch (error) {
          flushToolActivity(tracker);
          tracker.markdown?.flush();
          const durable = await harness.store.load(runId,harness.config.scope);
          session = await sessionStore.updateRun(session.sessionId, runId, {
            status: durable ? sessionStatus(durable.status) : "failed"
          });
          if (durable) { messages = durable.messages; retainedTasks = taskSources(durable.metadata); retainedResponses = durable.metadata?.zhivexAssistantResponses ?? []; }
          throw error;
        }
        if (progress.signal.aborted) process.stderr.write("Repeated identical tool failures; stopped to avoid a loop. Correct the cause before /continue.\n");
        flushToolActivity(tracker);
        tracker.markdown?.flush();
        if (!tracker.streamedText && result.outputText) {
          process.stdout.write(sanitizeTerminalText(result.outputText));
        }
        process.stdout.write("\n");
        messages = result.messages;
        retainedTasks = taskSources(result.state.metadata);
        retainedResponses = result.state.metadata?.zhivexAssistantResponses ?? [];
        attachments.clear();
        process.stderr.write(formatUsageLedger(result.state.metadata?.[USAGE_LEDGER_KEY]) + "\n");
        displayLedger = inspectUsageLedger(result.state.metadata?.[USAGE_LEDGER_KEY]);
        process.stderr.write(outcome(result) + "\n");
        process.stderr.write(await freshCodeTaskRecap(harness, result.state));
        codeTask = restoredCodeTask(result.state);
        session = await sessionStore.updateRun(session.sessionId, runId, {
          status: sessionStatus(result.status)
        });
        if (result.status === "failed" || result.status === "cancelled") process.stderr.write("Progress saved. Use /continue to start another run from these results, or /limits to adjust next turns.\n");
        if (result.status === "waiting_approval") {
          process.stderr.write(
            `Run ${result.state.runId} is paused; use /pending, /approve, or /deny here.\n`
          );
        }
      } catch (error) {
        if (readline.isClosed) break;
        const aborted = error instanceof Error && error.name === "AbortError";
        const recovery = commandInProgress.startsWith("/checkpoint") ? checkpointRecovery(terminalErrorMessage(error)) : undefined;
        consoleIssue = recovery ? "restore blocked · /checkpoint list" : aborted ? "interrupted · session retained" : "error · inspect message above";
        process.stderr.write(aborted
          ? "\nInput interrupted. Session retained; use /pending to inspect approvals.\n"
          : recovery ? `\n${sanitizeTerminalText(recovery)}`
          : `\n${sanitizeTerminalText(terminalErrorMessage(error))}\nSession retained; use /status and /activity. Inspect /pending before /continue.\n`);
      }
    }
  } finally {
    runView.end();
    process.off("SIGINT", interrupt);
    readline.close();
    await harness.close();
    sessionStore.close();
    credentials.store.clear();
  }
};
import { handleConsoleCompaction } from "./console/console-compaction.js";
