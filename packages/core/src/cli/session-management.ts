import { type AgentStatus } from "@zhivex-ai/agents";
import { resolveHarnessConfig, type HarnessConfig } from "../runtime/config.js";
import { openHarnessPersistence } from "../persistence/operations.js";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import { openCliSessionStore, type CliSession, type SessionRunStatus } from "../persistence/sessions.js";
import { HarnessStateConflictError } from "../runtime/errors.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

export const openSessionStoreForConfig = (config: HarnessConfig) => openCliSessionStore({
  workspace: config.workspace,
  stateDirectory: config.stateDirectory,
  scope: config.scope
});

const printSessionDocument = (document: unknown, json: boolean) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const record = document as { kind?: string; sessions?: CliSession[]; session?: CliSession };
  if (record.kind === "session-list") {
    for (const session of record.sessions ?? []) {
      const latest = session.runs.at(-1);
      process.stdout.write(
        `${session.sessionId} ${session.title ?? "(untitled)"} · ${session.runs.length} runs` +
        `${latest ? ` · ${latest.provider}/${latest.model} · ${latest.status}` : ""}\n`
      );
    }
    return;
  }
  const session = record.session;
  if (session) {
    process.stdout.write(
      `${session.sessionId} · ${session.title ?? "(untitled)"} · ${session.runs.length} runs` +
      `${session.archivedAt ? " · archived" : ""}\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
};

export const manageSessions = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  const store = await openSessionStoreForConfig(config);
  const refreshDurableStatus = async (selected: CliSession) => {
    if (!selected.runs.length) return selected;
    const persistence = await openHarnessPersistence(config);
    try {
      let refreshed = selected;
      for (const run of selected.runs) {
        const state = await persistence.store.load(run.runId, config.scope);
        if (!state) throw new HarnessStateConflictError(`Run ${run.runId} referenced by session ${selected.sessionId} was not found; restore its durable state before continuing.`);
        const status = sessionStatus(state.status);
        if (status !== run.status) refreshed = await store.updateRun(selected.sessionId, run.runId, { status });
      }
      return refreshed;
    } finally { persistence.close(); }
  };
  try {
    let session: CliSession | undefined;
    let document: unknown;
    switch (options.sessionsCommand) {
      case "list": {
        const summaries = await store.list({ ...(options.limit ? { limit: options.limit } : {}), ...(options.sessionSearch ? { search: options.sessionSearch } : {}) });
        const indexed = (await Promise.all(summaries.map((summary) => store.get(summary.sessionId))))
          .filter((value): value is CliSession => Boolean(value));
        const sessions = [];
        for (const selected of indexed) sessions.push(await refreshDurableStatus(selected));
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session-list" as const, sessions };
        break;
      }
      case "inspect":
        session = await store.get(options.sessionId!);
        if (!session) throw new HarnessStateConflictError(`Session ${options.sessionId} was not found.`);
        session = await refreshDurableStatus(session);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "rename":
        session = await store.rename(options.sessionId!, options.sessionTitle!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "fork":
        session = await store.fork(options.sessionId!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      case "archive":
        session = await store.archive(options.sessionId!);
        document = { schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "session" as const, session };
        break;
      default:
        throw new CliUsageError("sessions requires one of: list, inspect, rename, fork, archive.");
    }
    printSessionDocument(document, options.json);
  } finally {
    store.close();
  }
};

export const sessionStatus = (status: AgentStatus): SessionRunStatus => {
  if (status === "queued") return "created";
  if (status === "suspended") return "waiting_approval";
  return status;
};

export const updateIndexedSessionRun = async (
  config: HarnessConfig,
  runId: string,
  status: AgentStatus
) => {
  const store = await openSessionStoreForConfig(config);
  try {
    for (const summary of await store.list({ limit: 200, includeArchived: true })) {
      const session = await store.get(summary.sessionId);
      if (session?.runs.some((run) => run.runId === runId)) {
        await store.updateRun(session.sessionId, runId, { status: sessionStatus(status) });
        return;
      }
    }
  } finally {
    store.close();
  }
};
