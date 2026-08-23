import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { normalizeAgentRunState, type AgentRunState } from "@zhivex-ai/agents";

import type { HarnessConfig } from "./config.js";
import { HarnessStateConflictError, HarnessWorkspaceError } from "./errors.js";
import { readRegularFileNoFollow } from "./file-security.js";
import { HARNESS_OPERATIONS_SCHEMA_VERSION, HARNESS_SQLITE_FILE, openHarnessPersistence } from "./operations.js";
import { HARNESS_SESSION_SCHEMA_VERSION, openCliSessionStore } from "./sessions.js";
import { SqliteDatabase } from "./sqlite-database.js";
import { validateStateDirectory } from "./state-directory.js";

export const HARNESS_STATE_BACKUP_SCHEMA_VERSION = 1 as const;
export const HARNESS_STATE_BACKUP_MAX_BYTES = 64 * 1024 * 1024;

const terminalRunStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const terminalSessionStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bindingKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonRecordSchema = z.record(z.string(), z.unknown());
const durableScopeSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional()
}).strict();
const journalEntrySchema = z.object({
  runId: z.string().min(1),
  scope: durableScopeSchema,
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "failed"]),
  idempotencyKey: z.string().min(1),
  revision: z.number().int().nonnegative(),
  input: z.json().optional(),
  output: z.json().optional(),
  error: z.object({ message: z.string() }).strict().optional(),
  startedAt: z.number().nonnegative().optional(),
  completedAt: z.number().nonnegative().optional(),
  updatedAt: z.number().nonnegative()
}).passthrough();

const runRecordSchema = z.object({
  key: z.string().min(1).max(1_024),
  state: jsonRecordSchema,
  updatedAt: z.number().int().nonnegative()
}).strict();
const journalRecordSchema = z.object({
  runKey: z.string().min(1).max(1_024),
  toolCallId: z.string().min(1).max(1_024),
  entry: journalEntrySchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict();
const idempotencyRecordSchema = z.object({
  key: z.string().min(1).max(1_024),
  runKey: z.string().min(1).max(1_024),
  updatedAt: z.number().int().nonnegative()
}).strict();
const parentRecordSchema = z.object({
  runKey: z.string().min(1).max(1_024),
  parentRunKey: z.string().min(1).max(1_024),
  updatedAt: z.number().int().nonnegative()
}).strict();
const memoryRecordSchema = z.object({
  key: z.string().min(1).max(1_024),
  messages: z.array(z.unknown()),
  updatedAt: z.number().int().nonnegative()
}).strict();
const sessionRecordSchema = z.object({
  sessionId: z.string().min(1).max(260),
  workspaceKey: bindingKeySchema,
  scopeKey: bindingKeySchema,
  title: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  forkedFromTurnId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  activitySequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
  deletedAt: z.number().int().nonnegative().nullable(),
  metadataBytes: z.number().int().nonnegative()
}).strict();
const sessionRunRecordSchema = z.object({
  turnId: z.string().min(1).max(260),
  sourceTurnId: z.string().nullable(),
  sessionId: z.string().min(1).max(260),
  ordinal: z.number().int().nonnegative(),
  runId: z.string().min(1).max(260),
  provider: z.string().min(1).max(260),
  model: z.string().min(1).max(260),
  role: z.string().nullable(),
  status: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  metadataBytes: z.number().int().nonnegative()
}).strict();

const stateBackupPayloadSchema = z.object({
  schemaVersion: z.literal(HARNESS_STATE_BACKUP_SCHEMA_VERSION),
  kind: z.literal("state-backup"),
  createdAt: z.iso.datetime({ precision: 3 }),
  binding: z.object({
    workspaceKey: bindingKeySchema,
    scopeKey: bindingKeySchema,
    scopePrefix: z.string().min(1).max(1_024)
  }).strict(),
  schemas: z.object({
    operations: z.literal(HARNESS_OPERATIONS_SCHEMA_VERSION),
    sessions: z.literal(HARNESS_SESSION_SCHEMA_VERSION)
  }).strict(),
  records: z.object({
    runs: z.array(runRecordSchema),
    toolJournal: z.array(journalRecordSchema),
    idempotency: z.array(idempotencyRecordSchema),
    parents: z.array(parentRecordSchema),
    memory: z.array(memoryRecordSchema),
    sessions: z.array(sessionRecordSchema),
    sessionRuns: z.array(sessionRunRecordSchema)
  }).strict()
}).strict();

export const stateBackupBundleSchema = stateBackupPayloadSchema.extend({ checksum: digestSchema }).strict();
export type HarnessStateBackupBundle = z.infer<typeof stateBackupBundleSchema>;
type HarnessStateBackupPayload = z.infer<typeof stateBackupPayloadSchema>;

export interface HarnessStateImportOptions {
  dryRun?: boolean;
  /** Test-only deterministic failure injection used to certify rollback. */
  failAfterWrites?: number;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

const checksumPayload = (payload: HarnessStateBackupPayload) =>
  `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;

const stableKey = (kind: string, value: string) =>
  createHash("sha256").update(kind).update("\u0000").update(value).digest("hex");

const scopeValue = (config: HarnessConfig) =>
  `${config.scope.tenantId}\u0000${config.scope.userId ?? ""}\u0000${config.scope.namespace ?? ""}`;

const scopePrefix = (config: HarnessConfig) =>
  `${encodeURIComponent(config.scope.namespace ?? "default")}:${encodeURIComponent(config.scope.tenantId)}:${encodeURIComponent(config.scope.userId ?? "*")}:`;

const stateMatchesScope = (config: HarnessConfig, state: unknown) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const candidate = state as { scope?: unknown };
  if (!candidate.scope || typeof candidate.scope !== "object" || Array.isArray(candidate.scope)) return false;
  const scope = candidate.scope as Record<string, unknown>;
  return scope.tenantId === config.scope.tenantId &&
    (scope.userId ?? undefined) === (config.scope.userId ?? undefined) &&
    (scope.namespace ?? undefined) === (config.scope.namespace ?? undefined);
};

const bindingForConfig = async (config: HarnessConfig) => ({
  workspaceKey: stableKey("workspace", await realpath(path.resolve(config.workspace))),
  scopeKey: stableKey("scope", scopeValue(config)),
  scopePrefix: scopePrefix(config)
});

const parseJsonRecord = (value: string, label: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new HarnessStateConflictError(`${label} contains invalid JSON.`, { cause: error });
  }
  return jsonRecordSchema.parse(parsed);
};

const prepareDatabase = async (config: HarnessConfig) => {
  if (config.storeBackend !== "sqlite") {
    throw new HarnessStateConflictError("State backup requires the sqlite store backend.");
  }
  const persistence = await openHarnessPersistence(config, { migrateLegacyFileStore: false });
  persistence.close();
  const sessions = await openCliSessionStore({
    workspace: config.workspace,
    stateDirectory: config.stateDirectory,
    scope: config.scope
  });
  sessions.close();
  return path.join(await realpath(config.stateDirectory), HARNESS_SQLITE_FILE);
};

const locateExistingDatabase = async (config: HarnessConfig) => {
  if (config.storeBackend !== "sqlite") {
    throw new HarnessStateConflictError("State backup requires the sqlite store backend.");
  }
  await validateStateDirectory(config.workspace, config.stateDirectory);
  let canonicalStateDirectory: string;
  try {
    canonicalStateDirectory = await realpath(config.stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const databasePath = path.join(canonicalStateDirectory, HARNESS_SQLITE_FILE);
  try {
    const entry = await lstat(databasePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new HarnessWorkspaceError(`The SQLite state path must be a real file: ${databasePath}.`);
    }
    return databasePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

interface RunRow { run_id: string; state_json: string; updated_at_ms: number }
interface JournalRow { run_key: string; tool_call_id: string; entry_json: string; revision: number; updated_at_ms: number }
interface IdempotencyRow { idempotency_key: string; run_id: string; updated_at_ms: number }
interface ParentRow { run_id: string; parent_run_id: string; updated_at_ms: number }
interface LeaseRow { run_key: string; expires_at_ms: number }
interface MemoryRow { memory_key: string; messages_json: string; updated_at_ms: number }
interface SessionRow {
  session_id: string; workspace_key: string; scope_key: string; title: string | null;
  parent_session_id: string | null; forked_from_turn_id: string | null; revision: number;
  activity_seq: number; created_at: number; updated_at: number; archived_at: number | null;
  deleted_at: number | null; metadata_bytes: number;
}
interface SessionRunRow {
  turn_id: string; source_turn_id: string | null; session_id: string; ordinal: number;
  run_id: string; provider: string; model: string; role: string | null; status: string;
  created_at: number; updated_at: number; completed_at: number | null; metadata_bytes: number;
}

const assertTerminalState = (state: unknown, label: string) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new HarnessStateConflictError(`${label} is not a terminal run.`);
  }
  const candidate = state as { runId?: unknown; status?: unknown; pendingApprovals?: unknown };
  if (typeof candidate.runId !== "string" || !terminalRunStatuses.has(String(candidate.status))) {
    throw new HarnessStateConflictError(`${label} is not a terminal run.`);
  }
  if (Array.isArray(candidate.pendingApprovals) && candidate.pendingApprovals.length > 0) {
    throw new HarnessStateConflictError(`${label} retains approval authority and cannot be backed up.`);
  }
};

const validatedRunState = (value: Record<string, unknown>, label: string): AgentRunState => {
  try {
    return normalizeAgentRunState(value);
  } catch (error) {
    throw new HarnessStateConflictError(`${label} is not a valid AgentRunState.`, { cause: error });
  }
};

const readPayload = async (config: HarnessConfig): Promise<HarnessStateBackupPayload> => {
  const databasePath = await prepareDatabase(config);
  const binding = await bindingForConfig(config);
  const database = new SqliteDatabase(databasePath, { create: false, strict: true });
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    const runRows = database.query<RunRow, []>(
      "SELECT run_id, state_json, updated_at_ms FROM zhivex_agent_runs ORDER BY run_id"
    ).all().flatMap((row) => {
      const state = validatedRunState(parseJsonRecord(row.state_json, `Run ${row.run_id}`), `Run ${row.run_id}`);
      return stateMatchesScope(config, state) ? [{ row, state }] : [];
    });
    const runs = runRows.map(({ row, state }) => {
      assertTerminalState(state, `Run ${row.run_id}`);
      return { key: row.run_id, state, updatedAt: row.updated_at_ms };
    });
    const runKeys = new Set(runs.map((run) => run.key));
    const activeLeases = database.query<LeaseRow, []>(
      "SELECT run_key, expires_at_ms FROM zhivex_agent_runs_leases"
    ).all().filter((row) => runKeys.has(row.run_key) && row.expires_at_ms > Date.now()).length;
    if (activeLeases > 0) {
      throw new HarnessStateConflictError("State export refuses to capture active run leases.", { retryable: true });
    }
    const journal = database.query<JournalRow, []>(
      "SELECT run_key, tool_call_id, entry_json, revision, updated_at_ms FROM zhivex_agent_runs_tool_journal ORDER BY run_key, tool_call_id"
    ).all().filter((row) => runKeys.has(row.run_key)).map((row) => {
      let entry: z.infer<typeof journalEntrySchema>;
      try {
        entry = journalEntrySchema.parse(parseJsonRecord(row.entry_json, `Tool journal ${row.tool_call_id}`));
      } catch (error) {
        throw new HarnessStateConflictError(`Tool journal ${row.tool_call_id} is invalid.`, { cause: error });
      }
      if (!stateMatchesScope(config, entry)) {
        throw new HarnessStateConflictError(
          `Tool journal ${row.tool_call_id} is bound to another durable scope.`
        );
      }
      return {
        runKey: row.run_key,
        toolCallId: row.tool_call_id,
        entry,
        revision: row.revision,
        updatedAt: row.updated_at_ms
      };
    });
    const idempotency = database.query<IdempotencyRow, []>(
      "SELECT idempotency_key, run_id, updated_at_ms FROM zhivex_agent_runs_idempotency ORDER BY idempotency_key"
    ).all().filter((row) => runKeys.has(row.run_id)).map((row) => ({
      key: row.idempotency_key, runKey: row.run_id, updatedAt: row.updated_at_ms
    }));
    const parents = database.query<ParentRow, []>(
      "SELECT run_id, parent_run_id, updated_at_ms FROM zhivex_agent_runs_parents ORDER BY run_id"
    ).all().filter((row) => runKeys.has(row.run_id) && runKeys.has(row.parent_run_id)).map((row) => ({
      runKey: row.run_id, parentRunKey: row.parent_run_id, updatedAt: row.updated_at_ms
    }));
    const memoryKeys = new Set(runs.map((run) => `${binding.scopePrefix}${String(run.state.runId)}`));
    const memory = database.query<MemoryRow, []>(
      "SELECT memory_key, messages_json, updated_at_ms FROM zhivex_agent_memory ORDER BY memory_key"
    ).all().filter((row) => memoryKeys.has(row.memory_key)).map((row) => ({
      key: row.memory_key,
      messages: z.array(z.unknown()).parse(JSON.parse(row.messages_json)),
      updatedAt: row.updated_at_ms
    }));
    const sessionRows = database.query<SessionRow, []>(
      "SELECT * FROM zhivex_cli_sessions ORDER BY session_id"
    ).all().filter((row) => row.workspace_key === binding.workspaceKey && row.scope_key === binding.scopeKey);
    const selectedSessionIds = new Set(sessionRows.map((row) => row.session_id));
    const sessionRunRows = database.query<SessionRunRow, []>(
      "SELECT * FROM zhivex_cli_session_runs ORDER BY session_id, ordinal"
    ).all().filter((row) => selectedSessionIds.has(row.session_id));
    for (const row of sessionRunRows) {
      if (!terminalSessionStatuses.has(row.status) || !runs.some((run) => run.state.runId === row.run_id)) {
        throw new HarnessStateConflictError(`Session run ${row.run_id} is active or has no terminal run state.`);
      }
    }
    const sessions = sessionRows.map((row) => ({
      sessionId: row.session_id, workspaceKey: row.workspace_key, scopeKey: row.scope_key,
      title: row.title, parentSessionId: row.parent_session_id, forkedFromTurnId: row.forked_from_turn_id,
      revision: row.revision, activitySequence: row.activity_seq, createdAt: row.created_at,
      updatedAt: row.updated_at, archivedAt: row.archived_at, deletedAt: row.deleted_at,
      metadataBytes: row.metadata_bytes
    }));
    const sessionRuns = sessionRunRows.map((row) => ({
      turnId: row.turn_id, sourceTurnId: row.source_turn_id, sessionId: row.session_id,
      ordinal: row.ordinal, runId: row.run_id, provider: row.provider, model: row.model,
      role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      completedAt: row.completed_at, metadataBytes: row.metadata_bytes
    }));
    const payload = stateBackupPayloadSchema.parse({
      schemaVersion: HARNESS_STATE_BACKUP_SCHEMA_VERSION,
      kind: "state-backup",
      createdAt: new Date().toISOString(),
      binding,
      schemas: { operations: HARNESS_OPERATIONS_SCHEMA_VERSION, sessions: HARNESS_SESSION_SCHEMA_VERSION },
      records: { runs, toolJournal: journal, idempotency, parents, memory, sessions, sessionRuns }
    });
    database.exec("COMMIT");
    return payload;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close(false);
  }
};

export const createHarnessStateBackup = async (config: HarnessConfig): Promise<HarnessStateBackupBundle> => {
  const payload = await readPayload(config);
  return stateBackupBundleSchema.parse({ ...payload, checksum: checksumPayload(payload) });
};

const writePrivateBackup = async (target: string, contents: string) => {
  const requested = path.resolve(target);
  const parent = path.dirname(requested);
  let parentHandle;
  try {
    parentHandle = await open(parent, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!(await parentHandle.stat()).isDirectory()) {
      throw new Error("Backup parent is not a directory.");
    }
  } catch (error) {
    await parentHandle?.close();
    throw new HarnessWorkspaceError(`Backup parent must be a real non-symlink directory: ${parent}.`, {
      cause: error
    });
  }
  const staged = path.join(parent, `.zhivex-state-backup-${randomUUID()}.tmp`);
  let handle;
  let published = false;
  let stagedExists = false;
  try {
    handle = await open(
      staged,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    stagedExists = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await chmod(staged, 0o600);
    await handle.close();
    handle = undefined;
    // A hard link publishes the fully synced inode atomically and, unlike
    // rename(), fails instead of replacing an existing backup target.
    await link(staged, requested);
    published = true;
    await unlink(staged);
    stagedExists = false;
    await parentHandle.sync();
  } catch (error) {
    if (published) await unlink(requested).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
    if (stagedExists) await unlink(staged).catch(() => undefined);
    await parentHandle.close();
  }
};

export const exportHarnessStateBackup = async (config: HarnessConfig, target: string) => {
  const bundle = await createHarnessStateBackup(config);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > HARNESS_STATE_BACKUP_MAX_BYTES) {
    throw new HarnessStateConflictError("State backup exceeds the supported size limit.");
  }
  await writePrivateBackup(target, serialized);
  return {
    schemaVersion: HARNESS_STATE_BACKUP_SCHEMA_VERSION,
    kind: "state-export" as const,
    path: path.resolve(target),
    checksum: bundle.checksum,
    counts: Object.fromEntries(Object.entries(bundle.records).map(([name, rows]) => [name, rows.length]))
  };
};

export const readHarnessStateBackup = async (source: string): Promise<HarnessStateBackupBundle> => {
  const { contents, stat } = await readRegularFileNoFollow(path.resolve(source), {
    label: "Harness state backup",
    maxBytes: HARNESS_STATE_BACKUP_MAX_BYTES,
    requireSingleLink: true
  });
  if ((stat.mode & 0o077) !== 0) {
    throw new HarnessWorkspaceError("Harness state backup permissions must not grant group or other access.");
  }
  let input: unknown;
  try {
    input = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new HarnessStateConflictError("Harness state backup is not valid JSON.", { cause: error });
  }
  return validateStateBackupBundle(input);
};

const validateStateBackupBundle = (input: unknown): HarnessStateBackupBundle => {
  let bundle: HarnessStateBackupBundle;
  try {
    bundle = stateBackupBundleSchema.parse(input);
  } catch (error) {
    throw new HarnessStateConflictError("Harness state backup schema is invalid or unsupported.", { cause: error });
  }
  const { checksum, ...payload } = bundle;
  if (checksumPayload(payload) !== checksum) {
    throw new HarnessStateConflictError("Harness state backup checksum does not match its payload.");
  }
  return bundle;
};

const validateBundleBinding = async (config: HarnessConfig, bundle: HarnessStateBackupBundle) => {
  const expected = await bindingForConfig(config);
  if (canonicalJson(expected) !== canonicalJson(bundle.binding)) {
    throw new HarnessStateConflictError("Harness state backup cannot be rebound to a different workspace or scope.");
  }
  const runKeys = new Set(bundle.records.runs.map((run) => run.key));
  if (runKeys.size !== bundle.records.runs.length) {
    throw new HarnessStateConflictError("Harness state backup contains duplicate run keys.");
  }
  const runIds = new Set<string>();
  for (const run of bundle.records.runs) {
    const state = validatedRunState(run.state, `Run ${run.key}`);
    assertTerminalState(state, `Run ${run.key}`);
    if (!stateMatchesScope(config, state)) {
      throw new HarnessStateConflictError(`Run ${run.key} is bound to another durable scope.`);
    }
    runIds.add(state.runId);
    if (run.key !== `${expected.scopePrefix}${state.runId}`) {
      throw new HarnessStateConflictError(`Run ${run.key} does not match its bound scope and runId.`);
    }
  }
  const journalKeys = new Set<string>();
  for (const entry of bundle.records.toolJournal) {
    const journalKey = `${entry.runKey}\u0000${entry.toolCallId}`;
    if (journalKeys.has(journalKey) || !runKeys.has(entry.runKey) ||
      !stateMatchesScope(config, entry.entry) ||
      entry.entry.runId !== entry.runKey.slice(expected.scopePrefix.length)) {
      throw new HarnessStateConflictError(`Tool journal ${entry.toolCallId} is not bound to an imported run.`);
    }
    journalKeys.add(journalKey);
  }
  const idempotencyKeys = new Set<string>();
  for (const entry of bundle.records.idempotency) {
    if (idempotencyKeys.has(entry.key) || !runKeys.has(entry.runKey)) {
      throw new HarnessStateConflictError("Idempotency record is duplicated or targets a missing run.");
    }
    idempotencyKeys.add(entry.key);
    const state = bundle.records.runs.find((run) => run.key === entry.runKey)!.state;
    if (typeof state.idempotencyKey !== "string" || entry.key !== `${expected.scopePrefix}${state.idempotencyKey}`) {
      throw new HarnessStateConflictError("Idempotency record does not match its bound run state.");
    }
  }
  const parentKeys = new Set<string>();
  for (const entry of bundle.records.parents) {
    if (parentKeys.has(entry.runKey) || !runKeys.has(entry.runKey) || !runKeys.has(entry.parentRunKey)) {
      throw new HarnessStateConflictError("Parent record targets a missing run.");
    }
    parentKeys.add(entry.runKey);
  }
  const memoryKeys = new Set<string>();
  for (const entry of bundle.records.memory) {
    const memoryRunId = entry.key.startsWith(expected.scopePrefix)
      ? entry.key.slice(expected.scopePrefix.length)
      : "";
    if (memoryKeys.has(entry.key) || !runIds.has(memoryRunId)) {
      throw new HarnessStateConflictError(`Memory record ${entry.key} is not bound to an imported run.`);
    }
    memoryKeys.add(entry.key);
  }
  for (const session of bundle.records.sessions) {
    if (session.workspaceKey !== expected.workspaceKey || session.scopeKey !== expected.scopeKey) {
      throw new HarnessStateConflictError(`Session ${session.sessionId} is bound to another workspace or scope.`);
    }
  }
  const sessionIds = new Set(bundle.records.sessions.map((session) => session.sessionId));
  if (sessionIds.size !== bundle.records.sessions.length) {
    throw new HarnessStateConflictError("Harness state backup contains duplicate session IDs.");
  }
  for (const session of bundle.records.sessions) {
    if (session.parentSessionId && !sessionIds.has(session.parentSessionId)) {
      throw new HarnessStateConflictError(`Session ${session.sessionId} targets a missing parent session.`);
    }
  }
  const turnIds = new Set<string>();
  const sessionOrdinals = new Set<string>();
  const sessionRunIds = new Set<string>();
  for (const run of bundle.records.sessionRuns) {
    const ordinalKey = `${run.sessionId}\u0000${run.ordinal}`;
    const sessionRunKey = `${run.sessionId}\u0000${run.runId}`;
    if (turnIds.has(run.turnId) || sessionOrdinals.has(ordinalKey) || sessionRunIds.has(sessionRunKey) ||
      !sessionIds.has(run.sessionId) || !runIds.has(run.runId) || !terminalSessionStatuses.has(run.status)) {
      throw new HarnessStateConflictError(`Session run ${run.runId} is active or targets a missing session.`);
    }
    turnIds.add(run.turnId);
    sessionOrdinals.add(ordinalKey);
    sessionRunIds.add(sessionRunKey);
  }
  for (const run of bundle.records.sessionRuns) {
    if (run.sourceTurnId && !turnIds.has(run.sourceTurnId)) {
      throw new HarnessStateConflictError(`Session run ${run.runId} targets a missing source turn.`);
    }
  }
};

const rowJson = (value: unknown) => canonicalJson(value);

const setEquals = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

export const importHarnessStateBackup = async (
  config: HarnessConfig,
  bundle: HarnessStateBackupBundle,
  options: HarnessStateImportOptions = {}
) => {
  bundle = validateStateBackupBundle(bundle);
  await validateBundleBinding(config, bundle);
  const databasePath = options.dryRun
    ? await locateExistingDatabase(config)
    : await prepareDatabase(config);
  if (!databasePath) {
    return {
      schemaVersion: HARNESS_STATE_BACKUP_SCHEMA_VERSION,
      kind: "state-import" as const,
      dryRun: true,
      checksum: bundle.checksum,
      inserted: {},
      identical: 0
    };
  }
  const database = new SqliteDatabase(databasePath, {
    create: false,
    strict: true,
    ...(options.dryRun ? { readonly: true } : {})
  });
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(options.dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
  const availableTables = new Set(database.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map((row) => row.name));
  let writes = 0;
  let identical = 0;
  const inserted: Record<string, number> = {};
  const checkFailure = () => {
    if (options.failAfterWrites !== undefined && writes >= options.failAfterWrites) {
      throw new Error("Injected state import failure.");
    }
  };
  const insertOrCompare = (
    table: string,
    keyWhere: string,
    keyBindings: readonly unknown[],
    selectColumns: string,
    expected: readonly unknown[],
    insertSql: string,
    insertBindings: readonly unknown[]
  ) => {
    if (!availableTables.has(table)) {
      if (options.dryRun) return;
      throw new HarnessStateConflictError(`Required state table ${table} is unavailable.`);
    }
    const existing = database.query<Record<string, unknown>>(
      `SELECT ${selectColumns} FROM ${table} WHERE ${keyWhere}`
    ).get(...keyBindings as never[]);
    if (existing) {
      const actual = Object.values(existing).map((value) => typeof value === "string" && (value.startsWith("{") || value.startsWith("["))
        ? rowJson(JSON.parse(value))
        : value);
      const normalizedExpected = expected.map((value) => typeof value === "string" && (value.startsWith("{") || value.startsWith("["))
        ? rowJson(JSON.parse(value))
        : value);
      if (rowJson(actual) !== rowJson(normalizedExpected)) {
        throw new HarnessStateConflictError(`Conflicting state already exists in ${table}.`);
      }
      identical += 1;
      return;
    }
    if (options.dryRun) return;
    checkFailure();
    database.query(insertSql).run(...insertBindings as never[]);
    writes += 1;
    inserted[table] = (inserted[table] ?? 0) + 1;
  };

  try {
    const expectedKeys = {
      runs: new Set(bundle.records.runs.map((row) => row.key)),
      toolJournal: new Set(bundle.records.toolJournal.map((row) => `${row.runKey}\u0000${row.toolCallId}`)),
      idempotency: new Set(bundle.records.idempotency.map((row) => row.key)),
      parents: new Set(bundle.records.parents.map((row) => row.runKey)),
      memory: new Set(bundle.records.memory.map((row) => row.key)),
      sessions: new Set(bundle.records.sessions.map((row) => row.sessionId)),
      sessionRuns: new Set(bundle.records.sessionRuns.map((row) => row.turnId))
    };
    const destinationRunRows = availableTables.has("zhivex_agent_runs")
      ? database.query<RunRow, []>(
          "SELECT run_id, state_json, updated_at_ms FROM zhivex_agent_runs ORDER BY run_id"
        ).all().filter((row) => stateMatchesScope(config, parseJsonRecord(row.state_json, `Run ${row.run_id}`)))
      : [];
    const destinationRunKeys = new Set(destinationRunRows.map((row) => row.run_id));
    const destinationSessionRows = availableTables.has("zhivex_cli_sessions")
      ? database.query<SessionRow, []>("SELECT * FROM zhivex_cli_sessions ORDER BY session_id")
          .all().filter((row) => row.workspace_key === bundle.binding.workspaceKey && row.scope_key === bundle.binding.scopeKey)
      : [];
    const destinationSessionIds = new Set(destinationSessionRows.map((row) => row.session_id));
    const destinationKeys = {
      runs: destinationRunKeys,
      toolJournal: new Set(availableTables.has("zhivex_agent_runs_tool_journal")
        ? database.query<JournalRow, []>(
            "SELECT run_key, tool_call_id, entry_json, revision, updated_at_ms FROM zhivex_agent_runs_tool_journal"
          ).all().filter((row) => destinationRunKeys.has(row.run_key))
            .map((row) => `${row.run_key}\u0000${row.tool_call_id}`)
        : []),
      idempotency: new Set(availableTables.has("zhivex_agent_runs_idempotency")
        ? database.query<IdempotencyRow, []>(
            "SELECT idempotency_key, run_id, updated_at_ms FROM zhivex_agent_runs_idempotency"
          ).all().filter((row) => destinationRunKeys.has(row.run_id)).map((row) => row.idempotency_key)
        : []),
      parents: new Set(availableTables.has("zhivex_agent_runs_parents")
        ? database.query<ParentRow, []>(
            "SELECT run_id, parent_run_id, updated_at_ms FROM zhivex_agent_runs_parents"
          ).all().filter((row) => destinationRunKeys.has(row.run_id)).map((row) => row.run_id)
        : []),
      memory: new Set(availableTables.has("zhivex_agent_memory")
        ? database.query<MemoryRow, []>(
            "SELECT memory_key, messages_json, updated_at_ms FROM zhivex_agent_memory"
          ).all().filter((row) => destinationRunRows.some((run) => {
            const state = JSON.parse(run.state_json) as { runId?: unknown };
            return row.memory_key === `${bundle.binding.scopePrefix}${String(state.runId)}`;
          })).map((row) => row.memory_key)
        : []),
      sessions: destinationSessionIds,
      sessionRuns: new Set(availableTables.has("zhivex_cli_session_runs")
        ? database.query<SessionRunRow, []>(
            "SELECT * FROM zhivex_cli_session_runs ORDER BY session_id, ordinal"
          ).all().filter((row) => destinationSessionIds.has(row.session_id)).map((row) => row.turn_id)
        : [])
    };
    if (availableTables.has("zhivex_agent_runs_leases")) {
      const activeLease = database.query<LeaseRow, []>(
        "SELECT run_key, expires_at_ms FROM zhivex_agent_runs_leases"
      ).all().some((row) => (
        destinationRunKeys.has(row.run_key) || expectedKeys.runs.has(row.run_key)
      ) && row.expires_at_ms > Date.now());
      if (activeLease) {
        throw new HarnessStateConflictError("State import refuses a destination with active run leases.", {
          retryable: true
        });
      }
    }
    const destinationHasState = Object.values(destinationKeys).some((keys) => keys.size > 0);
    if (destinationHasState && Object.keys(expectedKeys).some((name) =>
      !setEquals(
        destinationKeys[name as keyof typeof destinationKeys],
        expectedKeys[name as keyof typeof expectedKeys]
      ))) {
      throw new HarnessStateConflictError(
        "State import requires an empty destination or an exactly identical prior import."
      );
    }
    for (const run of bundle.records.runs) insertOrCompare(
      "zhivex_agent_runs", "run_id = ?", [run.key], "state_json, updated_at_ms",
      [JSON.stringify(run.state), run.updatedAt],
      "INSERT INTO zhivex_agent_runs (run_id, state_json, updated_at_ms) VALUES (?, ?, ?)",
      [run.key, JSON.stringify(run.state), run.updatedAt]
    );
    for (const entry of bundle.records.idempotency) insertOrCompare(
      "zhivex_agent_runs_idempotency", "idempotency_key = ?", [entry.key], "run_id, updated_at_ms",
      [entry.runKey, entry.updatedAt],
      "INSERT INTO zhivex_agent_runs_idempotency (idempotency_key, run_id, updated_at_ms) VALUES (?, ?, ?)",
      [entry.key, entry.runKey, entry.updatedAt]
    );
    for (const entry of bundle.records.parents) insertOrCompare(
      "zhivex_agent_runs_parents", "run_id = ?", [entry.runKey], "parent_run_id, updated_at_ms",
      [entry.parentRunKey, entry.updatedAt],
      "INSERT INTO zhivex_agent_runs_parents (run_id, parent_run_id, updated_at_ms) VALUES (?, ?, ?)",
      [entry.runKey, entry.parentRunKey, entry.updatedAt]
    );
    for (const entry of bundle.records.toolJournal) insertOrCompare(
      "zhivex_agent_runs_tool_journal", "run_key = ? AND tool_call_id = ?", [entry.runKey, entry.toolCallId],
      "entry_json, revision, updated_at_ms", [JSON.stringify(entry.entry), entry.revision, entry.updatedAt],
      "INSERT INTO zhivex_agent_runs_tool_journal (run_key, tool_call_id, entry_json, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      [entry.runKey, entry.toolCallId, JSON.stringify(entry.entry), entry.revision, entry.updatedAt]
    );
    for (const entry of bundle.records.memory) insertOrCompare(
      "zhivex_agent_memory", "memory_key = ?", [entry.key], "messages_json, updated_at_ms",
      [JSON.stringify(entry.messages), entry.updatedAt],
      "INSERT INTO zhivex_agent_memory (memory_key, messages_json, updated_at_ms) VALUES (?, ?, ?)",
      [entry.key, JSON.stringify(entry.messages), entry.updatedAt]
    );
    for (const session of bundle.records.sessions) insertOrCompare(
      "zhivex_cli_sessions", "session_id = ?", [session.sessionId],
      "workspace_key, scope_key, title, parent_session_id, forked_from_turn_id, revision, activity_seq, created_at, updated_at, archived_at, deleted_at, metadata_bytes",
      [session.workspaceKey, session.scopeKey, session.title, session.parentSessionId, session.forkedFromTurnId,
        session.revision, session.activitySequence, session.createdAt, session.updatedAt, session.archivedAt,
        session.deletedAt, session.metadataBytes],
      "INSERT INTO zhivex_cli_sessions (session_id, workspace_key, scope_key, title, parent_session_id, forked_from_turn_id, revision, activity_seq, created_at, updated_at, archived_at, deleted_at, metadata_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [session.sessionId, session.workspaceKey, session.scopeKey, session.title, session.parentSessionId,
        session.forkedFromTurnId, session.revision, session.activitySequence, session.createdAt, session.updatedAt,
        session.archivedAt, session.deletedAt, session.metadataBytes]
    );
    for (const run of bundle.records.sessionRuns) insertOrCompare(
      "zhivex_cli_session_runs", "turn_id = ?", [run.turnId],
      "source_turn_id, session_id, ordinal, run_id, provider, model, role, status, created_at, updated_at, completed_at, metadata_bytes",
      [run.sourceTurnId, run.sessionId, run.ordinal, run.runId, run.provider, run.model, run.role, run.status,
        run.createdAt, run.updatedAt, run.completedAt, run.metadataBytes],
      "INSERT INTO zhivex_cli_session_runs (turn_id, source_turn_id, session_id, ordinal, run_id, provider, model, role, status, created_at, updated_at, completed_at, metadata_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [run.turnId, run.sourceTurnId, run.sessionId, run.ordinal, run.runId, run.provider, run.model, run.role,
        run.status, run.createdAt, run.updatedAt, run.completedAt, run.metadataBytes]
    );
    if (options.dryRun) database.exec("ROLLBACK");
    else database.exec("COMMIT");
    return {
      schemaVersion: HARNESS_STATE_BACKUP_SCHEMA_VERSION,
      kind: "state-import" as const,
      dryRun: options.dryRun ?? false,
      checksum: bundle.checksum,
      inserted,
      identical
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close(false);
  }
};

export const importHarnessStateBackupFile = async (
  config: HarnessConfig,
  source: string,
  options: HarnessStateImportOptions = {}
) => importHarnessStateBackup(config, await readHarnessStateBackup(source), options);

export const inspectHarnessState = async (config: HarnessConfig) => {
  const payload = await readPayload(config);
  return {
    schemaVersion: HARNESS_STATE_BACKUP_SCHEMA_VERSION,
    kind: "state-status" as const,
    compatible: true,
    schemas: payload.schemas,
    counts: Object.fromEntries(Object.entries(payload.records).map(([name, rows]) => [name, rows.length]))
  };
};
