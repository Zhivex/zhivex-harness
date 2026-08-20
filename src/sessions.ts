import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createRedactionPolicy } from "@zhivex-ai/agents";
import type { AgentStoreScope } from "@zhivex-ai/agents/ops";
import { Database } from "bun:sqlite";

import { validateStateDirectory } from "./state-directory.js";

export const HARNESS_SESSION_INDEX_FILE = "operations.sqlite";
export const HARNESS_SESSION_SCHEMA_VERSION = 1 as const;

export const SESSION_RUN_STATUSES = [
  "created",
  "running",
  "waiting_approval",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "timed_out"
] as const;

export const TERMINAL_SESSION_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out"
] as const;

export type SessionRunStatus = (typeof SESSION_RUN_STATUSES)[number];

export interface SessionRunReference {
  turnId: string;
  sourceTurnId?: string;
  sequence: number;
  runId: string;
  provider: string;
  model: string;
  role?: string;
  status: SessionRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CliSession {
  schemaVersion: typeof HARNESS_SESSION_SCHEMA_VERSION;
  sessionId: string;
  workspaceKey: string;
  scopeKey: string;
  title?: string;
  parentSessionId?: string;
  forkedFromTurnId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  deletedAt?: number;
  runs: SessionRunReference[];
}

export interface CliSessionSummary extends Omit<CliSession, "runs"> {
  runCount: number;
  latestRun?: SessionRunReference;
}

export interface CreateSessionInput {
  /** A short operator-facing label. It is redacted before persistence and must not contain a prompt. */
  title?: string;
  initialRun?: AppendSessionRunInput;
}

export interface AppendSessionRunInput {
  runId: string;
  provider: string;
  model: string;
  role?: string;
  status?: SessionRunStatus;
  createdAt?: number;
}

export interface UpdateSessionRunInput {
  status: SessionRunStatus;
  updatedAt?: number;
  completedAt?: number;
  expectedSessionRevision?: number;
}

export interface UpdateSessionInput {
  title?: string | null;
  archived?: boolean;
  expectedRevision?: number;
}

export interface ListSessionsQuery {
  limit?: number;
  includeArchived?: boolean;
  includeDeleted?: boolean;
}

export interface ForkSessionInput {
  atTurnId?: string;
  title?: string;
  expectedRevision?: number;
}

export interface SessionRetentionResult {
  before: number;
  deletedSessions: number;
}

export interface OpenSessionStoreOptions {
  workspace: string;
  stateDirectory: string;
  scope: AgentStoreScope;
  retentionMs?: number;
  maxSessionsPerWorkspace?: number;
  maxRunsPerSession?: number;
  maxMetadataBytes?: number;
  maxIndexBytes?: number;
  now?: () => number;
}

export interface CliSessionStore {
  readonly databasePath: string;
  readonly workspaceKey: string;
  readonly scopeKey: string;
  create(input?: CreateSessionInput): Promise<CliSession>;
  get(sessionId: string, options?: { includeDeleted?: boolean }): Promise<CliSession | undefined>;
  list(query?: ListSessionsQuery): Promise<CliSessionSummary[]>;
  latest(options?: { includeArchived?: boolean }): Promise<CliSession | undefined>;
  update(sessionId: string, input: UpdateSessionInput): Promise<CliSession>;
  rename(sessionId: string, title: string, options?: { expectedRevision?: number }): Promise<CliSession>;
  appendRun(
    sessionId: string,
    input: AppendSessionRunInput,
    options?: { expectedRevision?: number }
  ): Promise<CliSession>;
  updateRun(sessionId: string, runId: string, input: UpdateSessionRunInput): Promise<CliSession>;
  fork(sessionId: string, input?: ForkSessionInput): Promise<CliSession>;
  archive(sessionId: string, options?: { expectedRevision?: number }): Promise<CliSession>;
  delete(sessionId: string, options?: { expectedRevision?: number }): Promise<CliSession>;
  prune(options?: { before?: number }): Promise<SessionRetentionResult>;
  close(): void;
}

interface SessionRow {
  session_id: string;
  title: string | null;
  parent_session_id: string | null;
  forked_from_turn_id: string | null;
  revision: number;
  activity_seq: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  deleted_at: number | null;
}

interface RunRow {
  turn_id: string;
  source_turn_id: string | null;
  ordinal: number;
  run_id: string;
  provider: string;
  model: string;
  role: string | null;
  status: SessionRunStatus;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface CountRow {
  count: number;
}

interface SizeRow {
  size: number;
}

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_RUNS = 1_000;
const DEFAULT_MAX_METADATA_BYTES = 4_096;
const DEFAULT_MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_LIST_LIMIT = 200;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/;
const TERMINAL_STATUSES = new Set<SessionRunStatus>(TERMINAL_SESSION_RUN_STATUSES);
const ACTIVE_STATUSES = new Set<SessionRunStatus>([
  "created",
  "running",
  "waiting_approval",
  "cancel_requested"
]);
const STATUS_TRANSITIONS: Readonly<Record<SessionRunStatus, ReadonlySet<SessionRunStatus>>> = {
  created: new Set(["created", "running", "waiting_approval", "completed", "failed", "cancelled", "timed_out"]),
  running: new Set(["running", "waiting_approval", "cancel_requested", "completed", "failed", "cancelled", "timed_out"]),
  waiting_approval: new Set(["waiting_approval", "running", "cancel_requested", "completed", "failed", "cancelled", "timed_out"]),
  cancel_requested: new Set(["cancel_requested", "cancelled", "failed", "timed_out"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  timed_out: new Set(["timed_out"])
};

const metadataRedaction = createRedactionPolicy({
  includeEmails: true,
  rules: [
    { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { name: "common-provider-key", pattern: /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi },
    { name: "url-credentials", pattern: /:\/\/[^\s/@:]+:[^\s/@]+@/g, replacement: "://[REDACTED]@" }
  ]
});

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

const boundedInteger = (name: string, value: number | undefined, fallback: number, minimum: number) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return resolved;
};

const assertTimestamp = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
};

const assertIdentifier = (name: string, value: string) => {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${name} contains unsupported characters or exceeds 256 bytes.`);
  }
  if (metadataRedaction.redactText(value) !== value) {
    throw new Error(`${name} resembles sensitive metadata and cannot be stored in the session index.`);
  }
  return value;
};

const assertScopeSegment = (name: string, value: string) => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} must contain 1-128 printable characters.`);
  }
  return normalized;
};

const normalizeTitle = (value: string | undefined | null, maxMetadataBytes: number) => {
  if (value === undefined || value === null) {
    return value;
  }
  const normalized = metadataRedaction.redactText(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!normalized) {
    throw new Error("Session title must not be empty.");
  }
  if (byteLength(normalized) > maxMetadataBytes) {
    throw new Error(`Session title exceeds the ${maxMetadataBytes}-byte metadata limit.`);
  }
  return normalized;
};

const normalizeScope = (scope: AgentStoreScope) => {
  const tenantId = assertScopeSegment("scope.tenantId", scope.tenantId);
  const userId = scope.userId === undefined ? "" : assertScopeSegment("scope.userId", scope.userId);
  const namespace = scope.namespace === undefined ? "" : assertScopeSegment("scope.namespace", scope.namespace);
  return `${tenantId}\u0000${userId}\u0000${namespace}`;
};

const stableKey = (kind: string, value: string) =>
  createHash("sha256").update(kind).update("\u0000").update(value).digest("hex");

const sessionId = () => `ses_${randomUUID()}`;
const turnId = () => `turn_${randomUUID()}`;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const ensurePrivateDatabase = async (workspace: string, stateDirectory: string) => {
  const requestedStateDirectory = path.resolve(stateDirectory);
  await validateStateDirectory(workspace, requestedStateDirectory);
  await mkdir(requestedStateDirectory, { recursive: true, mode: 0o700 });
  const directoryEntry = await lstat(requestedStateDirectory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error(`The session state directory must be a real directory: ${requestedStateDirectory}.`);
  }
  await chmod(requestedStateDirectory, 0o700);
  const canonicalStateDirectory = await realpath(requestedStateDirectory);
  const databasePath = path.join(canonicalStateDirectory, HARNESS_SESSION_INDEX_FILE);

  let databaseEntry;
  try {
    databaseEntry = await lstat(databasePath);
  } catch (error) {
    if (!isMissing(error)) {
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
    throw new Error(`The session SQLite path must be a real file: ${databasePath}.`);
  }
  await chmod(databasePath, 0o600);
  return { databasePath, databaseEntry };
};

const toRunReference = (row: RunRow): SessionRunReference => ({
  turnId: row.turn_id,
  ...(row.source_turn_id ? { sourceTurnId: row.source_turn_id } : {}),
  sequence: row.ordinal,
  runId: row.run_id,
  provider: row.provider,
  model: row.model,
  ...(row.role ? { role: row.role } : {}),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
});

const metadataSize = (input: {
  title?: string | null;
  runId?: string;
  provider?: string;
  model?: string;
  role?: string | null;
}) => Object.values(input).reduce<number>((total, value) =>
  total + (typeof value === "string" ? byteLength(value) : 0), 0);

const isTerminal = (status: SessionRunStatus) => TERMINAL_STATUSES.has(status);

export const openCliSessionStore = async (options: OpenSessionStoreOptions): Promise<CliSessionStore> => {
  const workspace = await realpath(path.resolve(options.workspace));
  const workspaceEntry = await stat(workspace);
  if (!workspaceEntry.isDirectory()) {
    throw new Error(`The session workspace is not a directory: ${workspace}.`);
  }
  const scopeValue = normalizeScope(options.scope);
  const workspaceKey = stableKey("workspace", workspace);
  const scopeKey = stableKey("scope", scopeValue);
  const retentionMs = boundedInteger("retentionMs", options.retentionMs, DEFAULT_RETENTION_MS, 0);
  const maxSessions = boundedInteger("maxSessionsPerWorkspace", options.maxSessionsPerWorkspace, DEFAULT_MAX_SESSIONS, 1);
  const maxRuns = boundedInteger("maxRunsPerSession", options.maxRunsPerSession, DEFAULT_MAX_RUNS, 1);
  const maxMetadataBytes = boundedInteger("maxMetadataBytes", options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES, 32);
  const maxIndexBytes = boundedInteger("maxIndexBytes", options.maxIndexBytes, DEFAULT_MAX_INDEX_BYTES, 1_024);
  const now = options.now ?? Date.now;
  const { databasePath, databaseEntry } = await ensurePrivateDatabase(workspace, options.stateDirectory);
  const database = new Database(databasePath, { create: false, strict: true });
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw new Error("The CLI session store is closed.");
    }
  };

  const transaction = <T>(operation: () => T): T => {
    assertOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      const size = database.query<SizeRow, [string, string]>(`
        SELECT
          COALESCE((SELECT SUM(metadata_bytes) FROM zhivex_cli_sessions WHERE workspace_key = ?1 AND scope_key = ?2), 0) +
          COALESCE((SELECT SUM(r.metadata_bytes) FROM zhivex_cli_session_runs r JOIN zhivex_cli_sessions s ON s.session_id = r.session_id WHERE s.workspace_key = ?1 AND s.scope_key = ?2), 0)
          AS size
      `).get(workspaceKey, scopeKey)?.size ?? 0;
      if (size > maxIndexBytes) {
        throw new Error(`Session index metadata exceeds the ${maxIndexBytes}-byte limit.`);
      }
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  };

  const ensureRevision = (row: SessionRow, expected: number | undefined) => {
    if (expected !== undefined && row.revision !== expected) {
      throw new Error(`Session ${row.session_id} changed concurrently (expected revision ${expected}, found ${row.revision}).`);
    }
  };

  const selectSessionRow = (candidateSessionId: string, includeDeleted = false) => {
    assertIdentifier("sessionId", candidateSessionId);
    return database.query<SessionRow, [string, string, string]>(`
      SELECT session_id, title, parent_session_id, forked_from_turn_id, revision, activity_seq,
             created_at, updated_at, archived_at, deleted_at
      FROM zhivex_cli_sessions
      WHERE session_id = ?1 AND workspace_key = ?2 AND scope_key = ?3
      ${includeDeleted ? "" : "AND deleted_at IS NULL"}
    `).get(candidateSessionId, workspaceKey, scopeKey);
  };

  const requireSessionRow = (candidateSessionId: string, includeDeleted = false) => {
    const row = selectSessionRow(candidateSessionId, includeDeleted);
    if (!row) {
      throw new Error(`Session ${candidateSessionId} was not found in this workspace and scope.`);
    }
    return row;
  };

  const selectRuns = (candidateSessionId: string) => database.query<RunRow, [string]>(`
    SELECT turn_id, source_turn_id, ordinal, run_id, provider, model, role, status,
           created_at, updated_at, completed_at
    FROM zhivex_cli_session_runs
    WHERE session_id = ?1
    ORDER BY ordinal ASC
  `).all(candidateSessionId).map(toRunReference);

  const nextActivitySequence = () => database.query<CountRow, [string, string]>(`
    SELECT COALESCE(MAX(activity_seq), 0) + 1 AS count
    FROM zhivex_cli_sessions
    WHERE workspace_key = ?1 AND scope_key = ?2
  `).get(workspaceKey, scopeKey)?.count ?? 1;

  const sessionBase = (row: SessionRow): Omit<CliSession, "runs"> => ({
    schemaVersion: HARNESS_SESSION_SCHEMA_VERSION,
    sessionId: row.session_id,
    workspaceKey,
    scopeKey,
    ...(row.title ? { title: row.title } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.forked_from_turn_id ? { forkedFromTurnId: row.forked_from_turn_id } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at })
  });

  const hydrate = (row: SessionRow): CliSession => ({
    ...sessionBase(row),
    runs: selectRuns(row.session_id)
  });

  const latestRunRow = (candidateSessionId: string) => database.query<RunRow, [string]>(`
    SELECT turn_id, source_turn_id, ordinal, run_id, provider, model, role, status,
           created_at, updated_at, completed_at
    FROM zhivex_cli_session_runs
    WHERE session_id = ?1
    ORDER BY ordinal DESC
    LIMIT 1
  `).get(candidateSessionId);

  const assertNoActiveRun = (candidateSessionId: string, action: string) => {
    const latest = latestRunRow(candidateSessionId);
    if (latest && ACTIVE_STATUSES.has(latest.status)) {
      throw new Error(`Cannot ${action} session ${candidateSessionId} while run ${latest.run_id} is ${latest.status}.`);
    }
  };

  const insertRun = (
    candidateSessionId: string,
    input: AppendSessionRunInput,
    sequence: number,
    sourceTurnId?: string
  ) => {
    const runId = assertIdentifier("runId", input.runId);
    const provider = assertIdentifier("provider", input.provider);
    const model = assertIdentifier("model", input.model);
    const role = input.role === undefined ? null : assertIdentifier("role", input.role);
    const status = input.status ?? "created";
    if (!(SESSION_RUN_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Unsupported session run status: ${String(status)}.`);
    }
    const createdAt = input.createdAt ?? now();
    assertTimestamp("createdAt", createdAt);
    const entryBytes = metadataSize({ runId, provider, model, role });
    if (entryBytes > maxMetadataBytes) {
      throw new Error(`Run reference metadata exceeds the ${maxMetadataBytes}-byte limit.`);
    }
    const candidateTurnId = turnId();
    database.query(`
      INSERT INTO zhivex_cli_session_runs (
        turn_id, source_turn_id, session_id, ordinal, run_id, provider, model, role,
        status, created_at, updated_at, completed_at, metadata_bytes
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12)
    `).run(
      candidateTurnId,
      sourceTurnId ?? null,
      candidateSessionId,
      sequence,
      runId,
      provider,
      model,
      role,
      status,
      createdAt,
      isTerminal(status) ? createdAt : null,
      entryBytes
    );
  };

  try {
    const openedEntry = await lstat(databasePath);
    if (
      openedEntry.isSymbolicLink() ||
      !openedEntry.isFile() ||
      openedEntry.dev !== databaseEntry.dev ||
      openedEntry.ino !== databaseEntry.ino
    ) {
      throw new Error(`The session SQLite path changed while it was being opened: ${databasePath}.`);
    }
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS zhivex_cli_session_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO zhivex_cli_session_schema (singleton, version)
      VALUES (1, ${HARNESS_SESSION_SCHEMA_VERSION});
      CREATE TABLE IF NOT EXISTS zhivex_cli_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        title TEXT,
        parent_session_id TEXT,
        forked_from_turn_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        activity_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        deleted_at INTEGER,
        metadata_bytes INTEGER NOT NULL,
        CHECK (length(session_id) <= 260),
        CHECK (metadata_bytes >= 0)
      );
      CREATE INDEX IF NOT EXISTS zhivex_cli_sessions_latest
        ON zhivex_cli_sessions (workspace_key, scope_key, deleted_at, archived_at, activity_seq DESC);
      CREATE TABLE IF NOT EXISTS zhivex_cli_session_runs (
        turn_id TEXT PRIMARY KEY,
        source_turn_id TEXT,
        session_id TEXT NOT NULL REFERENCES zhivex_cli_sessions(session_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL CHECK (status IN ('created', 'running', 'waiting_approval', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata_bytes INTEGER NOT NULL,
        UNIQUE (session_id, ordinal),
        UNIQUE (session_id, run_id),
        CHECK (ordinal >= 0),
        CHECK (metadata_bytes >= 0)
      );
      CREATE INDEX IF NOT EXISTS zhivex_cli_session_runs_latest
        ON zhivex_cli_session_runs (session_id, ordinal DESC);
    `);
    const schemaVersion = database.query<{ version: number }, []>(
      "SELECT version FROM zhivex_cli_session_schema WHERE singleton = 1"
    ).get()?.version;
    if (schemaVersion !== HARNESS_SESSION_SCHEMA_VERSION) {
      throw new Error(`Unsupported CLI session schema version: ${String(schemaVersion)}.`);
    }
    await chmod(databasePath, 0o600);
  } catch (error) {
    database.close(false);
    throw error;
  }

  const prune = async (input: { before?: number } = {}): Promise<SessionRetentionResult> => transaction(() => {
    const before = input.before ?? Math.max(0, now() - retentionMs);
    assertTimestamp("before", before);
    const deletedSessions = database.query<CountRow, [string, string, number]>(`
      SELECT COUNT(*) AS count FROM zhivex_cli_sessions
      WHERE workspace_key = ?1 AND scope_key = ?2
        AND updated_at < ?3
        AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
    `).get(workspaceKey, scopeKey, before)?.count ?? 0;
    database.query(`
      DELETE FROM zhivex_cli_sessions
      WHERE workspace_key = ?1 AND scope_key = ?2
        AND updated_at < ?3
        AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
    `).run(workspaceKey, scopeKey, before);
    return { before, deletedSessions };
  });

  const store: CliSessionStore = {
    databasePath,
    workspaceKey,
    scopeKey,

    async create(input = {}) {
      return transaction(() => {
        const cutoff = Math.max(0, now() - retentionMs);
        database.query(`
          DELETE FROM zhivex_cli_sessions
          WHERE workspace_key = ?1 AND scope_key = ?2 AND updated_at < ?3
            AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
        `).run(workspaceKey, scopeKey, cutoff);
        const count = database.query<CountRow, [string, string]>(`
          SELECT COUNT(*) AS count FROM zhivex_cli_sessions
          WHERE workspace_key = ?1 AND scope_key = ?2
        `).get(workspaceKey, scopeKey)?.count ?? 0;
        if (count >= maxSessions) {
          throw new Error(`Session limit reached for this workspace and scope (${maxSessions}). Archive and prune an older session.`);
        }
        const createdAt = now();
        assertTimestamp("now", createdAt);
        const title = normalizeTitle(input.title, maxMetadataBytes) ?? null;
        const candidateSessionId = sessionId();
        const activitySequence = nextActivitySequence();
        database.query(`
          INSERT INTO zhivex_cli_sessions (
            session_id, workspace_key, scope_key, title, revision, created_at,
            updated_at, activity_seq, metadata_bytes
          ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?6, ?7)
        `).run(candidateSessionId, workspaceKey, scopeKey, title, createdAt, activitySequence, metadataSize({ title }));
        if (input.initialRun) {
          insertRun(candidateSessionId, input.initialRun, 0);
        }
        return hydrate(requireSessionRow(candidateSessionId));
      });
    },

    async get(candidateSessionId, input = {}) {
      assertOpen();
      const row = selectSessionRow(candidateSessionId, input.includeDeleted ?? false);
      return row ? hydrate(row) : undefined;
    },

    async list(query = {}) {
      assertOpen();
      const limit = boundedInteger("limit", query.limit, 50, 1);
      if (limit > MAX_LIST_LIMIT) {
        throw new Error(`limit cannot exceed ${MAX_LIST_LIMIT}.`);
      }
      const rows = database.query<SessionRow, [string, string, number]>(`
        SELECT session_id, title, parent_session_id, forked_from_turn_id, revision, activity_seq,
               created_at, updated_at, archived_at, deleted_at
        FROM zhivex_cli_sessions
        WHERE workspace_key = ?1 AND scope_key = ?2
          ${query.includeArchived ? "" : "AND archived_at IS NULL"}
          ${query.includeDeleted ? "" : "AND deleted_at IS NULL"}
        ORDER BY activity_seq DESC
        LIMIT ?3
      `).all(workspaceKey, scopeKey, limit);
      return rows.map((row) => {
        const latest = latestRunRow(row.session_id);
        const runCount = database.query<CountRow, [string]>(
          "SELECT COUNT(*) AS count FROM zhivex_cli_session_runs WHERE session_id = ?1"
        ).get(row.session_id)?.count ?? 0;
        return {
          ...sessionBase(row),
          runCount,
          ...(latest ? { latestRun: toRunReference(latest) } : {})
        };
      });
    },

    async latest(input = {}) {
      assertOpen();
      const row = database.query<SessionRow, [string, string]>(`
        SELECT session_id, title, parent_session_id, forked_from_turn_id, revision, activity_seq,
               created_at, updated_at, archived_at, deleted_at
        FROM zhivex_cli_sessions
        WHERE workspace_key = ?1 AND scope_key = ?2 AND deleted_at IS NULL
          ${input.includeArchived ? "" : "AND archived_at IS NULL"}
        ORDER BY activity_seq DESC
        LIMIT 1
      `).get(workspaceKey, scopeKey);
      return row ? hydrate(row) : undefined;
    },

    async update(candidateSessionId, input) {
      return transaction(() => {
        const row = requireSessionRow(candidateSessionId);
        ensureRevision(row, input.expectedRevision);
        if (input.archived === true) {
          assertNoActiveRun(candidateSessionId, "archive");
        }
        const title = input.title === undefined
          ? row.title
          : normalizeTitle(input.title, maxMetadataBytes) ?? null;
        const updatedAt = now();
        assertTimestamp("now", updatedAt);
        const archivedAt = input.archived === undefined
          ? row.archived_at
          : input.archived ? updatedAt : null;
        const activitySequence = nextActivitySequence();
        database.query(`
          UPDATE zhivex_cli_sessions
          SET title = ?1, archived_at = ?2, updated_at = ?3, revision = revision + 1,
              metadata_bytes = ?4, activity_seq = ?5
          WHERE session_id = ?6 AND workspace_key = ?7 AND scope_key = ?8 AND revision = ?9
        `).run(
          title,
          archivedAt,
          updatedAt,
          metadataSize({ title }),
          activitySequence,
          candidateSessionId,
          workspaceKey,
          scopeKey,
          row.revision
        );
        return hydrate(requireSessionRow(candidateSessionId));
      });
    },

    async rename(candidateSessionId, title, input = {}) {
      return store.update(candidateSessionId, {
        title,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision })
      });
    },

    async appendRun(candidateSessionId, input, appendOptions = {}) {
      return transaction(() => {
        const row = requireSessionRow(candidateSessionId);
        ensureRevision(row, appendOptions.expectedRevision);
        if (row.archived_at !== null) {
          throw new Error(`Cannot append a run to archived session ${candidateSessionId}.`);
        }
        const existing = database.query<RunRow, [string, string]>(`
          SELECT turn_id, source_turn_id, ordinal, run_id, provider, model, role, status,
                 created_at, updated_at, completed_at
          FROM zhivex_cli_session_runs WHERE session_id = ?1 AND run_id = ?2
        `).get(candidateSessionId, input.runId);
        if (existing) {
          const requestedStatus = input.status ?? "created";
          if (
            existing.provider === input.provider &&
            existing.model === input.model &&
            (existing.role ?? undefined) === input.role &&
            existing.status === requestedStatus
          ) {
            return hydrate(row);
          }
          throw new Error(`Run ${input.runId} is already immutably bound to ${existing.provider}/${existing.model} in this session.`);
        }
        assertNoActiveRun(candidateSessionId, "start another run in");
        const count = database.query<CountRow, [string]>(
          "SELECT COUNT(*) AS count FROM zhivex_cli_session_runs WHERE session_id = ?1"
        ).get(candidateSessionId)?.count ?? 0;
        if (count >= maxRuns) {
          throw new Error(`Run-reference limit reached for session ${candidateSessionId} (${maxRuns}).`);
        }
        insertRun(candidateSessionId, input, count);
        const updatedAt = now();
        assertTimestamp("now", updatedAt);
        const activitySequence = nextActivitySequence();
        database.query(`
          UPDATE zhivex_cli_sessions SET updated_at = ?1, activity_seq = ?2, revision = revision + 1
          WHERE session_id = ?3 AND revision = ?4
        `).run(updatedAt, activitySequence, candidateSessionId, row.revision);
        return hydrate(requireSessionRow(candidateSessionId));
      });
    },

    async updateRun(candidateSessionId, runId, input) {
      return transaction(() => {
        const session = requireSessionRow(candidateSessionId);
        ensureRevision(session, input.expectedSessionRevision);
        assertIdentifier("runId", runId);
        const run = database.query<RunRow, [string, string]>(`
          SELECT turn_id, source_turn_id, ordinal, run_id, provider, model, role, status,
                 created_at, updated_at, completed_at
          FROM zhivex_cli_session_runs WHERE session_id = ?1 AND run_id = ?2
        `).get(candidateSessionId, runId);
        if (!run) {
          throw new Error(`Run ${runId} is not linked to session ${candidateSessionId}.`);
        }
        if (!STATUS_TRANSITIONS[run.status].has(input.status)) {
          throw new Error(`Run ${runId} cannot transition from ${run.status} to ${input.status}.`);
        }
        const updatedAt = input.updatedAt ?? now();
        assertTimestamp("updatedAt", updatedAt);
        if (updatedAt < run.updated_at) {
          throw new Error(`Run ${runId} update timestamp cannot move backwards.`);
        }
        const completedAt = isTerminal(input.status)
          ? input.completedAt ?? updatedAt
          : null;
        if (completedAt !== null) {
          assertTimestamp("completedAt", completedAt);
          if (completedAt < run.created_at || completedAt > updatedAt) {
            throw new Error("completedAt must be between the run creation and update timestamps.");
          }
        }
        database.query(`
          UPDATE zhivex_cli_session_runs
          SET status = ?1, updated_at = ?2, completed_at = ?3
          WHERE session_id = ?4 AND run_id = ?5
        `).run(input.status, updatedAt, completedAt, candidateSessionId, runId);
        const activitySequence = nextActivitySequence();
        database.query(`
          UPDATE zhivex_cli_sessions SET updated_at = ?1, activity_seq = ?2, revision = revision + 1
          WHERE session_id = ?3 AND revision = ?4
        `).run(updatedAt, activitySequence, candidateSessionId, session.revision);
        return hydrate(requireSessionRow(candidateSessionId));
      });
    },

    async fork(candidateSessionId, input = {}) {
      return transaction(() => {
        const source = requireSessionRow(candidateSessionId);
        ensureRevision(source, input.expectedRevision);
        const sourceRuns = selectRuns(candidateSessionId);
        let forkRuns = sourceRuns;
        let forkedFromTurnId: string | undefined;
        if (input.atTurnId) {
          const index = sourceRuns.findIndex((run) => run.turnId === input.atTurnId);
          if (index < 0) {
            throw new Error(`Turn ${input.atTurnId} is not part of session ${candidateSessionId}.`);
          }
          forkRuns = sourceRuns.slice(0, index + 1);
          forkedFromTurnId = input.atTurnId;
        } else if (sourceRuns.length > 0) {
          forkedFromTurnId = sourceRuns.at(-1)!.turnId;
        }
        const branchPoint = forkRuns.at(-1);
        if (branchPoint && !isTerminal(branchPoint.status)) {
          throw new Error(`Cannot fork from non-terminal run ${branchPoint.runId} (${branchPoint.status}).`);
        }
        if (forkRuns.length > maxRuns) {
          throw new Error(`Fork history exceeds the ${maxRuns}-run limit.`);
        }
        const count = database.query<CountRow, [string, string]>(`
          SELECT COUNT(*) AS count FROM zhivex_cli_sessions
          WHERE workspace_key = ?1 AND scope_key = ?2
        `).get(workspaceKey, scopeKey)?.count ?? 0;
        if (count >= maxSessions) {
          throw new Error(`Session limit reached for this workspace and scope (${maxSessions}).`);
        }
        const createdAt = now();
        assertTimestamp("now", createdAt);
        const title = normalizeTitle(input.title, maxMetadataBytes) ?? source.title;
        const forkSessionId = sessionId();
        const activitySequence = nextActivitySequence();
        database.query(`
          INSERT INTO zhivex_cli_sessions (
            session_id, workspace_key, scope_key, title, parent_session_id,
            forked_from_turn_id, revision, created_at, updated_at, activity_seq, metadata_bytes
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7, ?8, ?9)
        `).run(
          forkSessionId,
          workspaceKey,
          scopeKey,
          title,
          candidateSessionId,
          forkedFromTurnId ?? null,
          createdAt,
          activitySequence,
          metadataSize({ title })
        );
        for (const [index, run] of forkRuns.entries()) {
          insertRun(forkSessionId, {
            runId: run.runId,
            provider: run.provider,
            model: run.model,
            ...(run.role ? { role: run.role } : {}),
            status: run.status,
            createdAt: run.createdAt
          }, index, run.turnId);
          database.query(`
            UPDATE zhivex_cli_session_runs
            SET updated_at = ?1, completed_at = ?2
            WHERE session_id = ?3 AND ordinal = ?4
          `).run(run.updatedAt, run.completedAt ?? null, forkSessionId, index);
        }
        return hydrate(requireSessionRow(forkSessionId));
      });
    },

    async archive(candidateSessionId, input = {}) {
      return store.update(candidateSessionId, {
        archived: true,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision })
      });
    },

    async delete(candidateSessionId, input = {}) {
      return transaction(() => {
        const row = requireSessionRow(candidateSessionId);
        ensureRevision(row, input.expectedRevision);
        assertNoActiveRun(candidateSessionId, "delete");
        const deletedAt = now();
        assertTimestamp("now", deletedAt);
        const activitySequence = nextActivitySequence();
        database.query(`
          UPDATE zhivex_cli_sessions
          SET deleted_at = ?1, updated_at = ?1, activity_seq = ?2, revision = revision + 1
          WHERE session_id = ?3 AND revision = ?4
        `).run(deletedAt, activitySequence, candidateSessionId, row.revision);
        return hydrate(requireSessionRow(candidateSessionId, true));
      });
    },

    prune,

    close() {
      if (!closed) {
        closed = true;
        database.close(false);
      }
    }
  };

  return store;
};

/** Compatibility-friendly name for consumers that do not care that the index is CLI-owned. */
export const openSessionStore = openCliSessionStore;
