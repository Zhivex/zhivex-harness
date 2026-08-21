import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import {
  cancelAgentRun,
  cancelAgentRunTree,
  createRedactionPolicy,
  getAgentBudgetStatus,
  type AgentRunState,
  type AgentStatus
} from "@zhivex-ai/agents";
import type {
  AgentMemoryStore,
  AgentRunStore,
  AgentToolCallJournalEntry,
  SqliteAgentRunStoreOptions
} from "@zhivex-ai/agents/ops";
import {
  createAgentTraceArtifact,
  createHierarchicalAgentTrace,
  createFileAgentMemoryStore,
  createFileAgentRunStore,
  createProductionTraceOptions,
  createSqliteAgentMemoryStore,
  createSqliteAgentRunStore
} from "@zhivex-ai/agents/ops";
import { createAgentRunLedger } from "@zhivex-ai/agents/control-plane";

import { defaultHarnessNamespace, type HarnessConfig, type HarnessStoreBackend } from "./config.js";
import { SqliteDatabase } from "./sqlite-database.js";
import { validateStateDirectory } from "./state-directory.js";

type SqliteDatabaseLike = SqliteAgentRunStoreOptions["db"];

export const HARNESS_SQLITE_FILE = "operations.sqlite";
export const HARNESS_OPERATIONS_SCHEMA_VERSION = 1 as const;

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const;

export interface HarnessMigrationResult {
  scannedRuns: number;
  migratedRuns: number;
  migratedToolCalls: number;
}

export interface HarnessPersistence {
  backend: HarnessStoreBackend;
  store: AgentRunStore;
  memory: AgentMemoryStore;
  databasePath?: string;
  migration: HarnessMigrationResult;
  close(): void;
}

export interface HarnessRunQuery {
  statuses?: AgentStatus[];
  limit?: number;
  cursor?: string;
  updatedAfter?: number;
  updatedBefore?: number;
}

const runSummary = (state: AgentRunState) => {
  const consumption = getAgentBudgetStatus(state, { includeChildRuns: false }).consumption;
  return {
    runId: state.runId,
    revision: state.revision ?? 0,
    status: state.status,
    provider: state.provider,
    model: state.modelId,
    agentId: state.agentId,
    parentRunId: state.parentRunId,
    idempotencyKey: state.idempotencyKey,
    scope: state.scope,
    steps: consumption.steps,
    toolCalls: consumption.toolCalls,
    toolErrors: consumption.toolErrors,
    pendingApprovals: state.pendingApprovals.length,
    compactions: state.compactions?.length ?? 0,
    childRuns: state.childRuns?.length ?? 0,
    usage: state.usage,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    cancelledAt: state.cancelledAt,
    cancellationReason: state.cancellationReason
  };
};

export const listHarnessRuns = async (
  store: AgentRunStore,
  config: HarnessConfig,
  query: HarnessRunQuery = {}
) => {
  if (!store.list) {
    throw new Error(`The ${config.storeBackend} run store does not support listing.`);
  }
  const page = await store.list(query, config.scope);
  return {
    schemaVersion: HARNESS_OPERATIONS_SCHEMA_VERSION,
    kind: "run-list" as const,
    scope: config.scope,
    backend: config.storeBackend,
    runs: page.items.map(runSummary),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
};

export const inspectHarnessRun = async (
  store: AgentRunStore,
  config: HarnessConfig,
  runId: string
) => {
  const state = await store.load(runId, config.scope);
  if (!state) {
    throw new Error(`Run ${runId} was not found in ${config.stateDirectory}.`);
  }
  const redaction = createRedactionPolicy({ includeEmails: true });
  const traceOptions = createProductionTraceOptions({
    includeMessages: false,
    includeToolInputs: false,
    includeToolOutputs: false,
    includeApprovalArguments: false,
    includeOutputText: false,
    outputPreviewLength: 240,
    redaction
  });
  const rawLedger = createAgentRunLedger(state, {
    includeTimeline: true,
    includeInput: false,
    includeOutput: false,
    includeMetadata: false,
    outputPreviewLength: 240,
    redaction,
    ...(config.costBudget
      ? {
          pricing: {
            inputCostPer1kTokens: config.costBudget.inputCostPer1kTokens,
            outputCostPer1kTokens: config.costBudget.outputCostPer1kTokens,
            currency: "USD"
          }
        }
      : {}),
    trace: traceOptions
  });
  const { outputText: _ledgerOutput, ...ledgerSnapshot } = rawLedger.snapshot;
  const ledger = { ...rawLedger, snapshot: ledgerSnapshot };
  const snapshot = ledgerSnapshot;
  const journal = await store.listToolCalls?.(runId, config.scope) ?? [];
  // The SDK hierarchy helper operates on an unscoped store view. Bind every
  // lookup to the harness scope so tenant-local runs cannot disappear from an
  // inspection or be mixed with another namespace.
  const hierarchyStore: AgentRunStore = {
    load: (candidateRunId) => store.load(candidateRunId, config.scope),
    save: (candidateState, options) => store.save(candidateState, options),
    findByParentRunId: (parentRunId) => store.findByParentRunId?.(parentRunId, config.scope) ?? []
  };
  const hierarchy = await createHierarchicalAgentTrace(hierarchyStore, runId, traceOptions);

  return {
    schemaVersion: HARNESS_OPERATIONS_SCHEMA_VERSION,
    kind: "run-inspection" as const,
    run: runSummary(state),
    budget: getAgentBudgetStatus(state, config.budget),
    snapshot,
    trace: createAgentTraceArtifact(state, traceOptions),
    hierarchy,
    ledger,
    toolJournal: journal.map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      status: entry.status,
      revision: entry.revision,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      updatedAt: entry.updatedAt,
      error: entry.error ? { message: redaction.redactText(entry.error.message) } : undefined
    }))
  };
};

export const cancelHarnessRun = async (
  store: AgentRunStore,
  config: HarnessConfig,
  runId: string,
  options: { reason?: string; cascade?: boolean; final?: boolean } = {}
) => {
  const cancellationOptions = {
    scope: config.scope,
    mode: options.final ? "final" as const : "request" as const,
    ...(options.reason ? { reason: options.reason } : {})
  };
  const result = options.cascade
    ? await cancelAgentRunTree(store, runId, cancellationOptions)
    : await cancelAgentRun(store, runId, cancellationOptions);
  if (!result || ("parent" in result && !result.parent)) {
    throw new Error(`Run ${runId} was not found in ${config.stateDirectory}.`);
  }
  return {
    schemaVersion: HARNESS_OPERATIONS_SCHEMA_VERSION,
    kind: "run-cancellation" as const,
    cascade: options.cascade ?? false,
    ...(options.cascade
      ? {
          parent: runSummary((result as Awaited<ReturnType<typeof cancelAgentRunTree>>).parent!),
          children: (result as Awaited<ReturnType<typeof cancelAgentRunTree>>).children.map(runSummary)
        }
      : { run: runSummary(result as AgentRunState) })
  };
};

export const cleanupHarnessRuns = async (
  store: AgentRunStore,
  config: HarnessConfig,
  options: { before: number; statuses?: AgentStatus[]; limit?: number }
) => {
  if (!store.deleteExpired) {
    throw new Error(`The ${config.storeBackend} run store does not support retention cleanup.`);
  }
  const statuses = options.statuses?.length
    ? options.statuses
    : [...TERMINAL_RUN_STATUSES];
  const deleted = await store.deleteExpired({
    before: options.before,
    statuses,
    limit: options.limit ?? 1_000
  }, config.scope);
  return {
    schemaVersion: HARNESS_OPERATIONS_SCHEMA_VERSION,
    kind: "run-cleanup" as const,
    before: options.before,
    statuses,
    deleted
  };
};

const emptyMigration = (): HarnessMigrationResult => ({
  scannedRuns: 0,
  migratedRuns: 0,
  migratedToolCalls: 0
});

const shouldMigrateLegacyRuns = (
  config: HarnessConfig,
  requested: boolean | undefined
) => requested ?? (
  config.scope.tenantId === "local" &&
  config.scope.userId === undefined &&
  config.scope.namespace === defaultHarnessNamespace(config.workspace)
);

const sqliteAdapter = (database: SqliteDatabase): SqliteDatabaseLike => ({
  exec(sql) {
    return database.exec(sql);
  },
  prepare<TResult extends Record<string, unknown>>(sql: string) {
    const statement = database.query(sql);
    const bindings = (params?: readonly unknown[] | Record<string, unknown>) =>
      params === undefined ? [] : Array.isArray(params) ? params : [params];
    return {
      run(params?: readonly unknown[] | Record<string, unknown>) {
        return statement.run(...bindings(params) as never[]);
      },
      get(params?: readonly unknown[] | Record<string, unknown>) {
        return statement.get(...bindings(params) as never[]) as TResult | undefined;
      },
      all(params?: readonly unknown[] | Record<string, unknown>) {
        return statement.all(...bindings(params) as never[]) as TResult[];
      }
    };
  }
});

const ensurePrivateStateDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`The state directory must be a real directory: ${directory}.`);
  }
  await chmod(directory, 0o700);
};

const migrateJournalEntry = (
  entry: AgentToolCallJournalEntry,
  state: AgentRunState,
  config: HarnessConfig
): AgentToolCallJournalEntry => ({
  ...entry,
  runId: state.runId,
  scope: config.scope
});

export const migrateLegacyFileRuns = async (
  directory: string,
  target: AgentRunStore,
  config: HarnessConfig
): Promise<HarnessMigrationResult> => {
  const source = createFileAgentRunStore({ directory });
  const result = emptyMigration();
  let cursor: string | undefined;

  do {
    const page = await source.list?.({ limit: 100, ...(cursor ? { cursor } : {}) });
    if (!page) {
      break;
    }
    for (const legacyState of page.items) {
      result.scannedRuns += 1;
      const existing = await target.load(legacyState.runId, config.scope);
      if (existing) {
        continue;
      }
      const migratedState: AgentRunState = {
        ...legacyState,
        scope: config.scope,
        metadata: {
          ...(legacyState.metadata ?? {}),
          migratedFrom: "0.3-file-store"
        }
      };
      await target.save(migratedState);
      result.migratedRuns += 1;

      const journal = await source.listToolCalls?.(legacyState.runId, legacyState.scope) ?? [];
      for (const entry of journal) {
        await target.saveToolCall?.(migrateJournalEntry(entry, migratedState, config));
        result.migratedToolCalls += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  return result;
};

export const openHarnessPersistence = async (
  config: HarnessConfig,
  options: { migrateLegacyFileStore?: boolean } = {}
): Promise<HarnessPersistence> => {
  await validateStateDirectory(config.workspace, config.stateDirectory);
  await ensurePrivateStateDirectory(config.stateDirectory);

  if (config.storeBackend === "file") {
    const store = createFileAgentRunStore({ directory: config.stateDirectory, scope: config.scope });
    const migration = shouldMigrateLegacyRuns(config, options.migrateLegacyFileStore)
      ? await migrateLegacyFileRuns(config.stateDirectory, store, config)
      : emptyMigration();
    return {
      backend: "file",
      store,
      memory: createFileAgentMemoryStore({
        directory: path.join(config.stateDirectory, "memory"),
        scope: config.scope
      }),
      migration,
      close() {}
    };
  }

  const databasePath = path.join(config.stateDirectory, HARNESS_SQLITE_FILE);
  let databaseEntry;
  try {
    databaseEntry = await lstat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      const handle = await open(databasePath, "wx", 0o600);
      await handle.close();
    } catch (creationError) {
      if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw creationError;
      }
    }
    databaseEntry = await lstat(databasePath);
  }
  if (databaseEntry.isSymbolicLink() || !databaseEntry.isFile()) {
    throw new Error(`The SQLite state path must be a real file: ${databasePath}.`);
  }

  const database = new SqliteDatabase(databasePath, { create: false, strict: true });
  let closed = false;
  const closeDatabase = () => {
    if (!closed) {
      closed = true;
      database.close(false);
    }
  };
  try {
    const openedEntry = await lstat(databasePath);
    if (
      openedEntry.isSymbolicLink() ||
      !openedEntry.isFile() ||
      openedEntry.dev !== databaseEntry.dev ||
      openedEntry.ino !== databaseEntry.ino
    ) {
      throw new Error(`The SQLite state path changed while it was being opened: ${databasePath}.`);
    }
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    await chmod(databasePath, 0o600);

    const databaseLike = sqliteAdapter(database);
    const store = createSqliteAgentRunStore({ db: databaseLike, scope: config.scope });
    const memory = createSqliteAgentMemoryStore({ db: databaseLike, scope: config.scope });
    const migration = shouldMigrateLegacyRuns(config, options.migrateLegacyFileStore)
      ? await migrateLegacyFileRuns(config.stateDirectory, store, config)
      : emptyMigration();

    return {
      backend: "sqlite",
      store,
      memory,
      databasePath,
      migration,
      close: closeDatabase
    };
  } catch (error) {
    closeDatabase();
    throw error;
  }
};
