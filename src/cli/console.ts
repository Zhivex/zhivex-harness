import { CliCredentials } from "./cli-credentials.js";
import { USAGE_LEDGER_KEY, formatUsageLedger, inspectUsageLedger } from "../runtime/usage-ledger.js";
import { TASK_SOURCE_KEY, taskSources } from "../context/task-memory.js";
import { TerminalMarkdown } from "./terminal/terminal-markdown.js";
import { navigateConsole } from "./console/console-navigation.js";
import { formatComposer } from "./console/console-presentation.js";
import { formatConsoleHelp } from "./console/console-commands.js";
import { formatConsoleWelcome } from "./console/console-welcome.js";
import { ConsoleInput } from "./console/console-input.js";
import { ConsoleAttachments, formatConsoleContext, formatConsoleDiff } from "./console/console-context.js";
import { sanitizeTerminalText, formatVerificationSummary } from "./terminal/terminal-ui.js";
import { randomUUID } from "node:crypto";
import { type AgentRunOutput } from "@zhivex-ai/agents";
import {
  DEFAULT_PROVIDER_REGISTRY,
  HARNESS_SUBAGENT_PROFILES,
  PROVIDERS,
  parseProvider,
  providerAvailability,
  providerDescriptor,
  resolveHarnessConfig,
  type HarnessSubagentProfile
} from "../runtime/config.js";
import { appendUserMessage, compactHarnessMessages, runHarness, type ZhivexHarness } from "../runtime/harness.js";
import { openHarnessPersistence } from "../persistence/operations.js";
import { runHarnessReviewGroup } from "../runtime/orchestration.js";
import { HARNESS_VERSION } from "../version.js";
import {
  parseHarnessModelRoute,
  resolveHarnessModelRoutes,
  serializeHarnessModelRoutes,
  type HarnessModelRoute
} from "../providers/routing.js";
import { type CliSession } from "../persistence/sessions.js";
import { terminalSupportsColor } from "./terminal/terminal-ui.js";
import { HarnessStateConflictError } from "../runtime/errors.js";
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
  summarizeApproval,
  terminalApprovalResolver,
  terminalErrorMessage
} from "./presentation.js";

export const chat = async (options: CliOptions) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Chat mode requires an interactive terminal. Use run for automation.");
  }
  const baseConfig = resolveHarnessConfig(options);
  const sessionStore = await openSessionStoreForConfig(baseConfig);
  const readline = new ConsoleInput(process.stdin, process.stdout);
  const attachments = new ConsoleAttachments();
  const credentials = { store: new CliCredentials(), input: readline };
  let credentialsRevision = credentials.store.revision;
  let activeController: AbortController | undefined;
  const interrupt = () => {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
      process.stderr.write("\nStopping the active operation; waiting for durable state and cleanup.\n");
    }
  };
  readline.onInterrupt = interrupt;
  process.on("SIGINT", interrupt);
  const abortable = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    activeController = controller;
    try { return await operation(controller.signal); }
    finally { activeController = undefined; }
  };
  let verbose = false;
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

  const latestState = async (selected: CliSession) => {
    const latest = selected.runs.at(-1);
    if (!latest) return undefined;
    const persistence = await openHarnessPersistence(baseConfig);
    try {
      const state = await persistence.store.load(latest.runId, baseConfig.scope);
      if (!state) throw new HarnessStateConflictError(`Run ${latest.runId} referenced by session ${selected.sessionId} was not found.`);
      return state;
    } finally {
      persistence.close();
    }
  };

  let harness: ZhivexHarness;
  try {
    const restored = await latestState(session);
    if (restored) {
      const persisted = readHarnessResumeConfig(restored);
      runtimeOptions = {
        ...runtimeOptions,
        ...persistedCliOptions(persisted),
        provider: restored.provider,
        model: restored.modelId
      };
      routes = readHarnessResumeRoutes(restored);
      messages = restored.messages;
      retainedTasks = taskSources(restored.metadata);
    }
    harness = (await createConfiguredHarness(runtimeOptions, [], routes, credentials)).harness;
    credentialsRevision = credentials.store.revision;
  } catch (error) {
    process.off("SIGINT", interrupt);
    readline.close();
    sessionStore.close();
    throw error;
  }

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
    const state = await latestState(selected);
    const persisted = state ? readHarnessResumeConfig(state) : undefined;
    const nextOptions = state
      ? { ...runtimeOptions, ...persistedCliOptions(persisted), provider: state.provider, model: state.modelId }
      : runtimeOptions;
    const nextRoutes = state ? readHarnessResumeRoutes(state) : resolveHarnessModelRoutes();
    await replaceHarness(nextOptions, nextRoutes);
    session = selected;
    attachments.clear();
    readline.clearHistory();
    messages = state?.messages ?? [];
    retainedTasks = taskSources(state?.metadata);
  };

  const continuePendingApproval = async (approve: boolean) => {
    const current = await refreshSession();
    const state = await latestState(current);
    if (!state || state.status !== "waiting_approval" || state.pendingApprovals.length === 0) {
      process.stderr.write("The current session has no pending approval.\n");
      return;
    }
    const tracker: { streamedText: boolean; markdown?: TerminalMarkdown } = { streamedText: false };
    session = await sessionStore.updateRun(session.sessionId, state.runId, { status: "running" });
    let result: AgentRunOutput;
    try {
      result = await abortable((abortSignal) => runHarness(
        harness,
        {
          state,
          abortSignal,
          approvals: approvalResponses(
            state.pendingApprovals,
            approve,
            approve ? "Approved inline in chat." : "Denied inline in chat."
          )
        },
        {
          onEvent: streamSink({ json: false, jsonl: false }, tracker, !verbose),
          resolveApprovals: terminalApprovalResolver(options.yes, (question) => readline.question(question))
        }
      ));
    } catch {
      flushToolActivity(tracker);
      tracker.markdown?.flush();
      const durable = await latestState(await refreshSession());
      session = await sessionStore.updateRun(session.sessionId, state.runId, {
        status: durable ? sessionStatus(durable.status) : "failed"
      });
      process.stderr.write(
        approve
          ? `Run ${state.runId} failed while applying the approval; inspect it with runs inspect.\n`
          : `Run ${state.runId} ended after the denial.\n`
      );
      return;
    }
    flushToolActivity(tracker);
    tracker.markdown?.flush();
    if (!tracker.streamedText && result.outputText) process.stdout.write(sanitizeTerminalText(result.outputText));
    if (result.outputText || tracker.streamedText) process.stdout.write("\n");
    messages = result.messages;
        retainedTasks = taskSources(result.state.metadata);
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
    const routeText = routes.size === 0
      ? "default"
      : [...routes.values()].map((route) => `${route.profile}=${route.provider}:${route.model}`).join(", ");
    return `session ${current.sessionId} · ${harness.config.provider}/${harness.config.model}` +
      ` · ${messages.length} messages · routes ${routeText}` +
      `${latest ? ` · last ${latest.runId} (${latest.status})` : ""}`;
  };

  process.stderr.write(formatConsoleWelcome({
    version: HARNESS_VERSION,
    workspace: harness.config.workspace,
    provider: harness.config.provider,
    model: harness.config.model,
    sessionId: session.sessionId,
    ...(session.title ? { sessionTitle: session.title } : {}),
  }, { color: terminalSupportsColor(Boolean(process.stderr.isTTY)), columns: process.stdout.columns ?? 80 }) + "\n");

  process.stderr.write(`Ready · credential: ${credentials.store.source(harness.config.provider)} · account access is not checked until your first task.\n`);
  process.stderr.write(options.yes ? "Automatic approvals are enabled.\n" : "Changes require your approval.\n");

  const showSessionState = async () => {
    await hasActiveTurn();
    const state = await latestState(await refreshSession());
    if (!state) return;
    process.stderr.write(`Run ${sanitizeTerminalText(state.runId)} · durable status: ${state.status}\n`);
    for (const approval of state.pendingApprovals) {
      process.stderr.write(`\nPending approval:\n${summarizeApproval(approval)}\n`);
    }
  };

  try {
    await showSessionState();
    for (;;) {
      try {
        process.stdout.write(formatComposer({
          model: `${harness.config.provider}/${harness.config.model}`,
          ...(session.title ? { title: session.title } : {}),
          status: session.runs.at(-1)?.status === "waiting_approval" ? "approval pending · /pending" : "ready",
          attachments: attachments.list().length,
          automaticApprovals: options.yes === true,
        }, process.stdout.columns));
        const submitted = await readline.question("\n> ", true);
        const literalInput = readline.lastSubmissionWasPaste || submitted.includes("\n");
        let prompt = literalInput ? submitted : submitted.trim();
        if (!prompt.trim()) {
          continue;
        }
        let command = literalInput ? "" : prompt;
        if (["/menu", "/provider", "/providers", "/model", "/models"].includes(command)) {
          const selection = await navigateConsole(readline, {
            entry: command === "/menu" ? "menu" : command.startsWith("/provider") ? "provider" : "model",
            current: {provider:harness.config.provider,model:harness.config.model},
            providers: providerAvailability(),
            sessions: async () => (await sessionStore.list({limit:200})).map(item => ({value:item.sessionId,label:item.title??"Untitled conversation",detail:item.sessionId})),
          });
          if (!selection) continue;
          if ("command" in selection) { command = selection.command; prompt = command; }
          else {
            const active = await hasActiveTurn();
            if (active) { process.stderr.write(`Cannot switch models while run ${active.runId} is ${active.status}.\n`); continue; }
            const portableMessages = compactHarnessMessages(messages);
            await replaceHarness({...runtimeOptions,provider:parseProvider(selection.provider),model:selection.model},routes);
            messages = portableMessages;
            process.stderr.write(`Next turn: ${selection.provider}/${selection.model}; context was compacted.\n`);
            continue;
          }
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
          process.stdout.write(sanitizeTerminalText(JSON.stringify(inspectUsageLedger(state?.metadata?.[USAGE_LEDGER_KEY]) ?? { message: "No transport ledger recorded for this run." }, null, 2)) + "\n");
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
          attachments.clear();
          readline.clearHistory();
          process.stderr.write("Context cleared.\n");
          continue;
        }
        if (command === "/status") {
          process.stderr.write(`${await statusLine()}\n`);
          continue;
        }
        if (command === "/diff") {
          const diff = await harness.workspace.gitDiff();
          const output = `${diff.status.stdout}${diff.diff.stdout}${diff.staged.stdout}`;
          process.stdout.write(formatConsoleDiff(output, terminalSupportsColor(Boolean(process.stdout.isTTY))) || "No workspace changes.\n");
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
          } else {
            for (const approval of state.pendingApprovals) {
              process.stderr.write(`\nPending approval:\n${summarizeApproval(approval)}\n`);
            }
          }
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
          await replaceHarness({ ...runtimeOptions, provider, model }, routes);
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
          await replaceHarness({ ...runtimeOptions, model: value }, routes);
          messages = portableMessages;
          process.stderr.write(`Next turn: ${harness.config.provider}/${value}; context was compacted.\n`);
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
          await showSessionState();
          const active = await hasActiveTurn();
          process.stderr.write(
            active
              ? `Session ${session.sessionId} has run ${active.runId} in ${active.status}; use /pending, /approve, or /deny here.\n`
              : `Resumed session ${session.sessionId}.\n`
          );
          continue;
        }
        if (command === "/review" || command.startsWith("/review ")) {
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
            ))
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
        if (!literalInput && prompt === "/paste") {
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
        prompt = await attachments.prompt(harness.workspace, prompt);
        const runId = `run_${randomUUID()}`;
        session = await sessionStore.appendRun(session.sessionId, {
          runId,
          provider: harness.config.provider,
          model: harness.config.model,
          status: "created"
        });
        const turn = session.runs.at(-1)!;

        const tracker: { streamedText: boolean; markdown?: TerminalMarkdown } = { streamedText: false };
        let markedRunning = false;
        let result: AgentRunOutput;
        try {
          result = await abortable((abortSignal) => runHarness(
            harness,
            messages.length === 0
              ? {
                  runId,
                  abortSignal,
                  prompt,
                  scope: harness.config.scope,
                  metadata: {
                    ...createHarnessResumeMetadata(harness.config, routes),
                    [TASK_SOURCE_KEY]: retainedTasks,
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
                  abortSignal,
                  messages: appendUserMessage(messages, prompt),
                  scope: harness.config.scope,
                  metadata: {
                    ...createHarnessResumeMetadata(harness.config, routes),
                    [TASK_SOURCE_KEY]: retainedTasks,
                    zhivexCliSession: {
                      schemaVersion: 1,
                      sessionId: session.sessionId,
                      turnId: turn.turnId,
                      sequence: turn.sequence
                    }
                  }
                },
            {
              onEvent: async (event) => {
                if (!markedRunning && event.type === "agent-run-start") {
                  session = await sessionStore.updateRun(session.sessionId, runId, { status: "running" });
                  markedRunning = true;
                }
                await streamSink({ json: false, jsonl: false }, tracker, !verbose)(event);
              },
              resolveApprovals: terminalApprovalResolver(options.yes, (question) => readline.question(question))
            }
          ));
        } catch (error) {
          flushToolActivity(tracker);
          tracker.markdown?.flush();
          const durable = await latestState(await refreshSession());
          session = await sessionStore.updateRun(session.sessionId, runId, {
            status: durable ? sessionStatus(durable.status) : "failed"
          });
          if (durable) { messages = durable.messages; retainedTasks = taskSources(durable.metadata); }
          throw error;
        }
        flushToolActivity(tracker);
        tracker.markdown?.flush();
        if (!tracker.streamedText && result.outputText) {
          process.stdout.write(sanitizeTerminalText(result.outputText));
        }
        process.stdout.write("\n");
        messages = result.messages;
        retainedTasks = taskSources(result.state.metadata);
        attachments.clear();
        process.stderr.write(formatUsageLedger(result.state.metadata?.[USAGE_LEDGER_KEY]) + "\n");
        process.stderr.write(formatVerificationSummary(result.toolResults) + "\n");
        session = await sessionStore.updateRun(session.sessionId, runId, {
          status: sessionStatus(result.status)
        });
        if (result.status === "waiting_approval") {
          process.stderr.write(
            `Run ${result.state.runId} is paused; use /pending, /approve, or /deny here.\n`
          );
        }
      } catch (error) {
        if (readline.isClosed) break;
        const aborted = error instanceof Error && error.name === "AbortError";
        process.stderr.write(aborted
          ? "\nInput interrupted. Session retained; use /pending to inspect approvals.\n"
          : `\n${sanitizeTerminalText(terminalErrorMessage(error))}\nSession retained; use /status or /pending.\n`);
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    readline.close();
    await harness.close();
    sessionStore.close();
    credentials.store.clear();
  }
};
