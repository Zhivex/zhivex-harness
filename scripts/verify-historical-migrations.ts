import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { AgentRunState } from "@zhivex-ai/agents";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import {
  migrateHarnessConfigInput,
  resolveHarnessConfig,
  type HarnessConfigInput
} from "../src/config.js";
import { inspectHarnessRun, openHarnessPersistence } from "../src/operations.js";
import { openCliSessionStore, type CliSession } from "../src/sessions.js";
import { createHarnessStateBackup } from "../src/state-backup.js";
import { createHarness, runHarness } from "../src/harness.js";
import { HARNESS_VERSION } from "../src/version.js";

interface HistoricalFixture {
  schemaVersion: number;
  kind: string;
  provenance: {
    package: string;
    version: string;
    tarball: string;
    integrity: string;
    sqliteSha256: string;
    generatedBy: string;
  };
  schemas: { config: number; operations: number; sessions: number };
  configInput: HarnessConfigInput;
  runs: AgentRunState[];
  toolJournal: Array<Record<string, unknown>>;
  memory: unknown[];
  sessions: Array<Record<string, any>>;
  sqliteTables: Array<{ name: string; sql: string }>;
}

const expected = {
  "0.10.0": {
    config: 4,
    integrity: "sha512-ecy7Kj4iKmzgnVd9f21/d3SqFqvUjFk5TPx2Esjg17tRopRzYQglPp9WYTrieBuc9x3Qh/7V/ZafXEprS69ffg=="
  },
  "0.11.1": {
    config: 5,
    integrity: "sha512-lF1ZzWi4HKsAUAdrpFb6Gf3afsrv89Mkm6tnqA/EGCHGWKZ7c1qQaM2opxrKFQIFQhfWJO4BrYMWQLDWC840kA=="
  }
} as const;

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const fixtureRoot = path.resolve(import.meta.dirname, "..", "fixtures", "migrations");

const loadFixture = async (version: keyof typeof expected): Promise<HistoricalFixture> =>
  JSON.parse(await readFile(path.join(fixtureRoot, `${version}.json`), "utf8")) as HistoricalFixture;

const verifyFixtureShape = (fixture: HistoricalFixture, version: keyof typeof expected) => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.kind, "published-migration-fixture");
  assert.equal(fixture.provenance.package, "@zhivex-ai/harness");
  assert.equal(fixture.provenance.version, version);
  assert.equal(fixture.provenance.integrity, expected[version].integrity);
  assert.match(fixture.provenance.sqliteSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.schemas.config, expected[version].config);
  assert.equal(fixture.schemas.operations, 1);
  assert.equal(fixture.schemas.sessions, 1);
  assert.match(fixture.provenance.tarball, new RegExp(`harness-${version.replaceAll(".", "\\.")}\\.tgz$`));
  assert.equal(fixture.provenance.generatedBy, "scripts/generate-historical-migration-fixtures.ts");

  const tables = new Set(fixture.sqliteTables.map((table) => table.name));
  for (const table of [
    "zhivex_agent_runs",
    "zhivex_agent_runs_idempotency",
    "zhivex_agent_runs_leases",
    "zhivex_agent_runs_parents",
    "zhivex_agent_runs_tool_journal",
    "zhivex_agent_memory",
    "zhivex_cli_session_schema",
    "zhivex_cli_sessions",
    "zhivex_cli_session_runs"
  ]) assert(tables.has(table), `${version} is missing published table ${table}`);
  assert(fixture.sqliteTables.every((table) => table.sql.startsWith("CREATE TABLE")));

  const terminal = fixture.runs.filter((run) => terminalStatuses.has(run.status));
  const paused = fixture.runs.filter((run) => run.status === "waiting_approval");
  assert.equal(terminal.length, 2);
  assert.equal(paused.length, 1);
  assert.equal(paused[0]?.harness?.version, version);
  assert.equal(terminal.filter((run) => run.parentRunId).length, 1);
  assert.equal(fixture.toolJournal.length, 1);
  assert(Array.isArray(fixture.memory));
  assert.equal(fixture.sessions.length, 2);
  const archived = fixture.sessions.find((session) => session.sessionId === "session-parent");
  const fork = fixture.sessions.find((session) => session.sessionId === "session-fork");
  assert.equal(typeof archived?.archivedAt, "number");
  assert.equal(fork?.parentSessionId, "session-parent");
  assert(fork?.runs.every((run: Record<string, unknown>) => typeof run.sourceTurnId === "string"));
  assert(!JSON.stringify(fixture.sessions).includes("abcdefgh12345678"));
};

const verifyHistoricalDatabase = async (fixture: HistoricalFixture) => {
  const source = path.join(fixtureRoot, `${fixture.provenance.version}.sqlite`);
  const bytes = await readFile(source);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(digest, fixture.provenance.sqliteSha256);

  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `zhivex-historical-db-${fixture.provenance.version}-`)));
  try {
    const workspace = path.parse(root).root;
    const stateDirectory = path.join(root, "state");
    await mkdir(stateDirectory);
    const databasePath = path.join(stateDirectory, "operations.sqlite");
    await copyFile(source, databasePath);

    // Published databases retain WAL journal mode. Opening the isolated copy
    // read-write lets SQLite create its transient sidecars before verification;
    // the source fixture digest above remains byte-for-byte evidence.
    const raw = new DatabaseSync(databasePath);
    assert.equal(raw.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM zhivex_agent_runs").get()?.count, 3);
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM zhivex_cli_sessions").get()?.count, 2);
    const tableDefinitions = raw.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'zhivex_%'
      ORDER BY name
    `).all().map((row) => ({
      name: String(row.name),
      sql: String(row.sql)
    }));
    assert.deepEqual(tableDefinitions, fixture.sqliteTables);
    raw.close();

    const migrated = migrateHarnessConfigInput({
      ...fixture.configInput,
      workspace,
      stateDirectory
    });
    const config = resolveHarnessConfig(migrated.config);
    const persistence = await openHarnessPersistence(config, { migrateLegacyFileStore: false });
    const page = await persistence.store.list?.({ limit: 100 }, config.scope);
    assert.equal(page?.items.length, 3);
    const parent = await persistence.store.load("published-parent", config.scope);
    const child = await persistence.store.load("published-child", config.scope);
    const paused = await persistence.store.load("published-paused", config.scope);
    assert.equal(parent?.runId, "published-parent");
    assert.equal(child?.parentRunId, "published-parent");
    assert.equal(paused?.status, "waiting_approval");
    assert.equal(paused?.harness?.version, fixture.provenance.version);
    assert.equal((await persistence.store.listToolCalls?.("published-child", config.scope))?.length, 1);
    assert.deepEqual(await persistence.memory.load?.({
      runId: "published-parent",
      scope: config.scope
    }), fixture.memory);
    const inspection = await inspectHarnessRun(persistence.store, config, "published-child");
    assert(!JSON.stringify(inspection).includes("abcdefgh12345678"));
    persistence.close();

    const sessionStore = await openCliSessionStore({
      workspace,
      stateDirectory,
      scope: config.scope
    });
    const summaries = await sessionStore.list({ limit: 10, includeArchived: true });
    assert.equal(summaries.length, 2);
    const historicalSessions = (await Promise.all(
      summaries.map((summary) => sessionStore.get(summary.sessionId))
    )).filter((session): session is CliSession => Boolean(session));
    assert.equal(historicalSessions.length, 2);
    const archivedSession = historicalSessions.find((session) => session.archivedAt !== undefined);
    const forkedSession = historicalSessions.find((session) => session.parentSessionId !== undefined);
    assert(archivedSession);
    assert(forkedSession);
    assert.equal(forkedSession.parentSessionId, archivedSession.sessionId);
    assert(forkedSession.runs.every((run) => typeof run.sourceTurnId === "string"));
    sessionStore.close();

    if (HARNESS_VERSION !== fixture.provenance.version) {
      const harness = await createHarness({
        ...migrated.config,
        modelInstance: createMockLanguageModel({
          provider: "current-fixture-provider",
          modelId: "published-fixture-model"
        })
      });
      try {
        await assert.rejects(
          runHarness(harness, { state: paused!, approvals: [] }),
          (error: unknown) => Boolean(
            error && typeof error === "object" &&
            (error as { code?: unknown }).code === "STATE_CONFLICT"
          )
        );
      } finally {
        await harness.close();
      }
    }
    await assert.rejects(createHarnessStateBackup(config), /not a terminal run|approval authority/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const verifyCurrentMigration = async (fixture: HistoricalFixture) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `zhivex-migration-check-${fixture.provenance.version}-`));
  try {
    const workspace = path.join(root, "workspace");
    const stateDirectory = path.join(root, "state");
    await mkdir(workspace);
    await mkdir(stateDirectory);
    const input: HarnessConfigInput = {
      ...fixture.configInput,
      workspace,
      stateDirectory
    };
    const migrated = migrateHarnessConfigInput(input);
    assert.equal(migrated.fromVersion, fixture.schemas.config);
    assert.equal(migrated.toVersion, 5);
    if (fixture.schemas.config === 4) {
      assert.equal(migrated.config.projectContext, false);
      assert(migrated.notes.length > 0);
    } else {
      assert.deepEqual(migrated.config, input);
      assert.deepEqual(migrated.notes, []);
    }
    const config = resolveHarnessConfig(migrated.config);
    const persistence = await openHarnessPersistence(config, { migrateLegacyFileStore: false });
    const terminal = fixture.runs
      .filter((run) => terminalStatuses.has(run.status))
      .map((run) => ({ ...run, scope: config.scope }));
    const parent = terminal.find((run) => run.runId === "published-parent")!;
    const child = terminal.find((run) => run.runId === "published-child")!;
    const claim = await persistence.store.claimIdempotencyKey?.(parent);
    assert.equal(claim?.claimed, true);
    await persistence.store.save(child);
    const journal = fixture.toolJournal[0]!;
    await persistence.store.saveToolCall?.({ ...journal, scope: config.scope } as never);
    await persistence.memory.save?.({ runId: parent.runId, scope: config.scope, state: parent });
    persistence.close();

    const reopened = await openHarnessPersistence(config, { migrateLegacyFileStore: false });
    assert.equal((await reopened.store.load(parent.runId, config.scope))?.runId, parent.runId);
    assert.equal((await reopened.store.load(child.runId, config.scope))?.parentRunId, parent.runId);
    assert.equal((await reopened.store.listToolCalls?.(child.runId, config.scope))?.length, 1);
    const duplicate = await reopened.store.claimIdempotencyKey?.({ ...parent, runId: "duplicate" });
    assert.equal(duplicate?.claimed, false);
    assert.equal(duplicate?.state.runId, parent.runId);
    const inspection = await inspectHarnessRun(reopened.store, config, child.runId);
    assert(!JSON.stringify(inspection).includes("abcdefgh12345678"));
    assert.equal(inspection.run.parentRunId, parent.runId);
    reopened.close();

    const sessions = await openCliSessionStore({
      workspace,
      stateDirectory,
      scope: config.scope,
      now: (() => { let timestamp = 5_000; return () => timestamp++; })()
    });
    const created = await sessions.create({
      title: "historical terminal history",
      initialRun: {
        runId: parent.runId,
        provider: parent.provider,
        model: parent.modelId,
        status: "completed"
      }
    });
    await sessions.appendRun(created.sessionId, {
      runId: child.runId,
      provider: child.provider,
      model: child.modelId,
      status: "completed"
    });
    const fork = await sessions.fork(created.sessionId);
    const archived = await sessions.archive(created.sessionId);
    assert.equal(archived.runs.length, 2);
    assert.equal(fork.parentSessionId, created.sessionId);
    assert(fork.runs.every((run) => typeof run.sourceTurnId === "string"));
    sessions.close();

    const paused = { ...fixture.runs.find((run) => run.status === "waiting_approval")!, scope: config.scope };
    const resumeDocument = paused.metadata?.zhivexHarnessResume as Record<string, any> | undefined;
    assert.equal(resumeDocument?.schemaVersion, 1);
    assert.equal(resumeDocument?.config?.schemaVersion, fixture.schemas.config);
    assert.equal(paused.pendingApprovals.length, 1);
    const pausedStore = await openHarnessPersistence(config, { migrateLegacyFileStore: false });
    await pausedStore.store.save(paused);
    pausedStore.close();
    await assert.rejects(
      createHarnessStateBackup(config),
      /not a terminal run|approval authority/,
      "paused historical approvals must remain original-artifact-only"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const verifyHistoricalMigrations = async () => {
  for (const version of Object.keys(expected) as Array<keyof typeof expected>) {
    const fixture = await loadFixture(version);
    verifyFixtureShape(fixture, version);
    await verifyHistoricalDatabase(fixture);
    await verifyCurrentMigration(fixture);
  }
};

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  await verifyHistoricalMigrations();
  process.stdout.write("Published 0.10.0/0.11.1 migration fixtures passed.\n");
}
