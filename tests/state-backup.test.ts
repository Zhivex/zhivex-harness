import { Workspace } from "../src/workspace/workspace.js";
import { openWorkspaceCheckpointStore } from "../src/persistence/workspace-checkpoints.js";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunState } from "@zhivex-ai/agents";
import { createFileAgentRunStore } from "@zhivex-ai/agents/ops";

import { resolveHarnessConfig } from "../src/runtime/config.js";
import { HARNESS_SQLITE_FILE, openHarnessPersistence } from "../src/persistence/operations.js";
import { openCliSessionStore } from "../src/persistence/sessions.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import {
  createHarnessStateBackup,
  exportHarnessStateBackup,
  importHarnessStateBackup,
  inspectHarnessState,
  readHarnessStateBackup
} from "../src/persistence/state-backup.js";

const temporaryDirectories: string[] = [];

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

const withChecksum = <T extends { checksum: string }>(bundle: T): T => {
  const { checksum: _checksum, ...payload } = bundle;
  return {
    ...bundle,
    checksum: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const terminalState = (
  runId: string,
  scope: ReturnType<typeof resolveHarnessConfig>["scope"],
  parentRunId?: string
): AgentRunState => ({
  schemaVersion: 1,
  revision: 0,
  runId,
  provider: "openai",
  modelId: "gpt-fixture",
  status: "completed",
  messages: [],
  steps: [],
  toolResults: [],
  currentStep: 0,
  maxSteps: 2,
  outputText: "",
  pendingApprovals: [],
  compactions: [],
  scope,
  ...(parentRunId ? { parentRunId } : {}),
  startedAt: 1_000,
  updatedAt: 2_000
});

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-state-backup-"));
  const workspace = path.join(root, "workspace");
  const sourceState = path.join(root, "source-state");
  const targetState = path.join(root, "target-state");
  await Promise.all([workspace, sourceState, targetState].map((directory) =>
    mkdir(directory, { recursive: true })
  ));
  temporaryDirectories.push(root);
  const source = resolveHarnessConfig({
    workspace,
    stateDirectory: sourceState,
    tenantId: "tenant-a",
    namespace: "backup-tests"
  });
  const target = resolveHarnessConfig({
    workspace,
    stateDirectory: targetState,
    tenantId: "tenant-a",
    namespace: "backup-tests"
  });
  return { root, source, target };
};

describe("WAL-safe logical state backup", () => {
  test("exports and restores terminal runs, journals, memory, and session lineage", async () => {
    const { root, source, target } = await fixture();
    const persistence = await openHarnessPersistence(source);
    const parent = { ...terminalState("parent-run", source.scope), idempotencyKey: "request-1" };
    const child = terminalState("child-run", source.scope, parent.runId);
    await persistence.store.claimIdempotencyKey?.(parent);
    await persistence.store.save(child);
    await persistence.store.saveToolCall?.({
      runId: child.runId,
      scope: source.scope,
      toolCallId: "tool-1",
      toolName: "read_file",
      status: "completed",
      idempotencyKey: "tool-request-1",
      revision: 0,
      output: { redacted: true },
      updatedAt: 2_000,
      completedAt: 2_000
    });
    await persistence.memory.save?.({ runId: parent.runId, scope: source.scope, state: parent });
    persistence.close();

    const sessions = await openCliSessionStore({
      workspace: source.workspace,
      stateDirectory: source.stateDirectory,
      scope: source.scope
    });
    const session = await sessions.create({
      title: "terminal lineage",
      initialRun: {
        runId: parent.runId,
        provider: parent.provider,
        model: parent.modelId,
        status: "completed"
      }
    });
    await sessions.appendRun(session.sessionId, {
      runId: child.runId,
      provider: child.provider,
      model: child.modelId,
      status: "completed"
    });
    await sessions.archive(session.sessionId);
    sessions.close();

    const backupPath = path.join(root, "backup.json");
    const exported = await exportHarnessStateBackup(source, backupPath);
    expect(exported.kind).toBe("state-export");
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);
    const bundle = await readHarnessStateBackup(backupPath);
    expect(bundle.records.runs).toHaveLength(2);
    expect(bundle.records.parents).toHaveLength(1);
    expect(bundle.records.toolJournal).toHaveLength(1);
    expect(bundle.records.memory).toHaveLength(1);
    expect(bundle.records.sessionRuns).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain("leases");

    const dryRun = await importHarnessStateBackup(target, bundle, { dryRun: true });
    expect(dryRun).toMatchObject({ kind: "state-import", dryRun: true, identical: 0 });
    const empty = await openHarnessPersistence(target);
    expect(await empty.store.load(parent.runId, target.scope)).toBeUndefined();
    empty.close();

    const applied = await importHarnessStateBackup(target, bundle);
    expect(applied.dryRun).toBe(false);
    const restored = await openHarnessPersistence(target);
    expect(await restored.store.load(parent.runId, target.scope)).toMatchObject({ runId: parent.runId });
    expect(await restored.store.load(child.runId, target.scope)).toMatchObject({ parentRunId: parent.runId });
    expect(await restored.store.listToolCalls?.(child.runId, target.scope)).toHaveLength(1);
    restored.close();
    const restoredSessions = await openCliSessionStore({
      workspace: target.workspace,
      stateDirectory: target.stateDirectory,
      scope: target.scope
    });
    expect(await restoredSessions.get(session.sessionId)).toMatchObject({
      archivedAt: expect.any(Number),
      runs: [{ runId: parent.runId }, { runId: child.runId }]
    });
    restoredSessions.close();

    const duplicate = await importHarnessStateBackup(target, bundle);
    expect(duplicate.identical).toBeGreaterThan(0);
    expect(Object.values(duplicate.inserted).reduce((total, count) => total + count, 0)).toBe(0);
    expect(await inspectHarnessState(target)).toMatchObject({
      kind: "state-status",
      compatible: true,
      counts: { runs: 2, sessionRuns: 2 }
    });
  });

  test("rejects tampering, future schemas, symlinks, rebinding, and non-private bundles", async () => {
    const { root, source, target } = await fixture();
    const persistence = await openHarnessPersistence(source);
    await persistence.store.save(terminalState("run-1", source.scope));
    persistence.close();
    const bundle = await createHarnessStateBackup(source);
    const backupPath = path.join(root, "backup.json");

    await expect(importHarnessStateBackup(target, {
      ...bundle,
      createdAt: "2026-08-23T00:00:00.000Z"
    })).rejects.toThrow("checksum");

    const malformed = withChecksum({
      ...bundle,
      records: {
        ...bundle.records,
        runs: bundle.records.runs.map((run) => ({
          ...run,
          state: {
            runId: run.state.runId,
            status: run.state.status,
            pendingApprovals: []
          }
        }))
      }
    });
    await expect(importHarnessStateBackup(target, malformed as never))
      .rejects.toThrow("valid AgentRunState");

    await writeFile(backupPath, JSON.stringify({ ...bundle, createdAt: "2026-08-23T00:00:00.000Z" }));
    await chmod(backupPath, 0o600);
    await expect(readHarnessStateBackup(backupPath)).rejects.toThrow("checksum");

    await writeFile(backupPath, JSON.stringify({ ...bundle, schemaVersion: 2 }));
    await expect(readHarnessStateBackup(backupPath)).rejects.toThrow();

    await writeFile(backupPath, JSON.stringify(bundle));
    await chmod(backupPath, 0o644);
    await expect(readHarnessStateBackup(backupPath)).rejects.toThrow("permissions");
    await chmod(backupPath, 0o600);
    const linkedPath = path.join(root, "linked.json");
    await symlink(backupPath, linkedPath);
    await expect(readHarnessStateBackup(linkedPath)).rejects.toThrow("regular file");

    const otherWorkspace = path.join(root, "other-workspace");
    await mkdir(otherWorkspace, { recursive: true });
    const rebound = resolveHarnessConfig({
      workspace: otherWorkspace,
      stateDirectory: target.stateDirectory,
      tenantId: "tenant-a",
      namespace: "backup-tests"
    });
    await expect(importHarnessStateBackup(rebound, bundle)).rejects.toThrow("rebound");
  });

  test("publishes backups atomically without leaving staged files after a target conflict", async () => {
    const { root, source } = await fixture();
    const persistence = await openHarnessPersistence(source);
    await persistence.store.save(terminalState("run-1", source.scope));
    persistence.close();
    const backupPath = path.join(root, "backup.json");
    await writeFile(backupPath, "existing backup\n", { mode: 0o600 });
    const entriesBefore = (await readdir(root)).sort();

    await expect(exportHarnessStateBackup(source, backupPath)).rejects.toThrow();

    expect(await readFile(backupPath, "utf8")).toBe("existing backup\n");
    expect((await readdir(root)).sort()).toEqual(entriesBefore);

    const realParent = path.join(root, "backup-parent");
    const linkedParent = path.join(root, "linked-backup-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await expect(exportHarnessStateBackup(source, path.join(linkedParent, "backup.json")))
      .rejects.toThrow("real non-symlink directory");
  });

  test("allows exactly one concurrent no-clobber state export", async () => {
    const { root, source } = await fixture();
    const persistence = await openHarnessPersistence(source);
    await persistence.store.save(terminalState("run-1", source.scope));
    persistence.close();
    const backupPath = path.join(root, "backup.json");

    const outcomes = await Promise.allSettled([
      exportHarnessStateBackup(source, backupPath),
      exportHarnessStateBackup(source, backupPath)
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await readHarnessStateBackup(backupPath)).records.runs).toHaveLength(1);
    expect((await readdir(root)).filter((entry) => entry.startsWith(".zhivex-state-backup-")))
      .toHaveLength(0);
  });

  test("fails closed on conflicts and rolls back injected failures", async () => {
    const { root, source, target } = await fixture();
    const persistence = await openHarnessPersistence(source);
    await persistence.store.save(terminalState("run-a", source.scope));
    await persistence.store.save(terminalState("run-b", source.scope));
    persistence.close();
    const bundle = await createHarnessStateBackup(source);

    await expect(importHarnessStateBackup(target, bundle, { failAfterWrites: 1 }))
      .rejects.toThrow("Injected");
    const afterRollback = await openHarnessPersistence(target);
    expect(await afterRollback.store.load("run-a", target.scope)).toBeUndefined();
    expect(await afterRollback.store.load("run-b", target.scope)).toBeUndefined();
    await afterRollback.store.save({
      ...terminalState("run-a", target.scope),
      outputText: "conflicting"
    });
    afterRollback.close();
    await expect(importHarnessStateBackup(target, bundle)).rejects.toThrow("empty destination");

    const serialized = await readFile(path.join(source.stateDirectory, "operations.sqlite"));
    expect(serialized.byteLength).toBeGreaterThan(0);
    expect(root).toBeString();
  });

  test("refuses active leases and paused approvals", async () => {
    const { source } = await fixture();
    const persistence = await openHarnessPersistence(source);
    const leased = terminalState("leased-run", source.scope);
    await persistence.store.save(leased);
    await persistence.store.acquireLease?.(leased.runId, {
      ownerId: "worker-1",
      ttlMs: 60_000,
      now: Date.now()
    }, source.scope);
    persistence.close();
    await expect(createHarnessStateBackup(source)).rejects.toThrow("active run leases");

    const resumed = await openHarnessPersistence(source);
    await resumed.store.releaseLease?.(leased.runId, "worker-1", source.scope);
    const paused = {
      ...terminalState("paused-run", source.scope),
      status: "waiting_approval" as const,
      pendingApprovals: [{
        provider: "local",
        id: "approval-1",
        name: "apply_patch",
        arguments: "{}",
        rawData: null
      }]
    };
    await resumed.store.save(paused);
    resumed.close();
    await expect(createHarnessStateBackup(source)).rejects.toThrow("not a terminal run");
  });

  test("refuses an orphaned active destination lease for a run being imported", async () => {
    const { source, target } = await fixture();
    const sourcePersistence = await openHarnessPersistence(source);
    await sourcePersistence.store.save(terminalState("leased-import", source.scope));
    sourcePersistence.close();
    const bundle = await createHarnessStateBackup(source);

    const targetPersistence = await openHarnessPersistence(target);
    targetPersistence.close();
    const database = new SqliteDatabase(path.join(target.stateDirectory, HARNESS_SQLITE_FILE), {
      create: false,
      strict: true
    });
    database.query(
      "INSERT INTO zhivex_agent_runs_leases (run_key, run_id, owner_id, expires_at_ms) VALUES (?, ?, ?, ?)"
    ).run(bundle.records.runs[0]!.key, "leased-import", "orphan-worker", Date.now() + 60_000);
    database.close();

    await expect(importHarnessStateBackup(target, bundle, { dryRun: true }))
      .rejects.toThrow("active run leases");
    await expect(importHarnessStateBackup(target, bundle)).rejects.toThrow("active run leases");
    const afterRejectedImport = await openHarnessPersistence(target);
    expect(await afterRejectedImport.store.load("leased-import", target.scope)).toBeUndefined();
    afterRejectedImport.close();
  });

  test("reserves the wildcard scope marker so absent and literal users cannot collide", async () => {
    const { source } = await fixture();
    expect(() => resolveHarnessConfig({
      workspace: source.workspace,
      stateDirectory: source.stateDirectory,
      tenantId: source.scope.tenantId,
      userId: "*",
      ...(source.scope.namespace ? { namespace: source.scope.namespace } : {})
    })).toThrow('reserved "*"');
  });

  test("keeps dry-run non-mutating when only a legacy file store exists", async () => {
    const { source, target } = await fixture();
    const sourcePersistence = await openHarnessPersistence(source);
    await sourcePersistence.store.save(terminalState("source-run", source.scope));
    sourcePersistence.close();
    const bundle = await createHarnessStateBackup(source);

    const legacy = createFileAgentRunStore({ directory: target.stateDirectory });
    await legacy.save(terminalState("legacy-run", target.scope));
    const sqlitePath = path.join(target.stateDirectory, "operations.sqlite");
    await expect(lstat(sqlitePath)).rejects.toThrow();

    const result = await importHarnessStateBackup(target, bundle, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, inserted: {}, identical: 0 });
    await expect(lstat(sqlitePath)).rejects.toThrow();
  });
});


test("portable backups preserve checkpoint captures and completed restores, rejecting unfinished restore authority", async () => {
  const { source, target } = await fixture();
  const persistence = await openHarnessPersistence(source);
  const run = terminalState("checkpoint-run", source.scope);
  await persistence.store.save(run);
  persistence.close();
  const sessions = await openCliSessionStore({ workspace: source.workspace, stateDirectory: source.stateDirectory, scope: source.scope });
  const workspace = await Workspace.open(source.workspace);
  const checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
  let checkpointId: string;
  let operationId: string;
  try {
    const session = await sessions.create({ initialRun: { runId: run.runId, provider: run.provider, model: run.modelId, status: "completed" } });
    await writeFile(path.join(source.workspace, "captured.txt"), "original");
    const capture = await checkpoints.capture({ sessionId: session.sessionId, turnId: session.runs[0]!.turnId, paths: ["captured.txt"] });
    checkpointId = capture.id;
    await writeFile(path.join(source.workspace, "captured.txt"), "agent change");
    const prepared = await checkpoints.prepareRestore(capture.id, { "captured.txt": (await workspace.readFile("captured.txt")).digest });
    operationId = prepared.operation.id;
    await expect(createHarnessStateBackup(source)).rejects.toThrow("unfinished workspace restore");
    await checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId);
  } finally { checkpoints.close(); sessions.close(); }
  const bundle = await createHarnessStateBackup(source);
  expect(bundle.records.workspaceCheckpoints).toHaveLength(2);
  await importHarnessStateBackup(target, bundle, { dryRun: true });
  await importHarnessStateBackup(target, bundle);
  await importHarnessStateBackup(target, bundle); // identical imports retain journal and snapshot bytes
  const restoredSessions = await openCliSessionStore({ workspace: target.workspace, stateDirectory: target.stateDirectory, scope: target.scope });
  const restored = await openWorkspaceCheckpointStore(workspace, restoredSessions);
  try {
    expect(restored.getCheckpoint(checkpointId!).files[0]?.content).toBe("original");
    expect(restored.getOperation(operationId!).stage).toBe("completed");
  } finally { restored.close(); restoredSessions.close(); }
  const invalid = structuredClone(bundle);
  invalid.records.workspaceCheckpoints![0]!.scopeKey = "0".repeat(64);
  await expect(importHarnessStateBackup(target, withChecksum(invalid))).rejects.toThrow("binding");
  const unfinished = structuredClone(bundle);
  const operation = unfinished.records.workspaceCheckpoints!.find((entry) => entry.kind === "restore")!;
  if (operation.kind === "restore") operation.body.stage = "prepared";
  await expect(importHarnessStateBackup(target, withChecksum(unfinished))).rejects.toThrow("unfinished");
});

test("portable backups preserve shared budget receipts and auxiliary usage without resetting spent tokens", async () => {
  const { createAgentBudgetCoordinator } = await import("@zhivex-ai/core");
  const { source, target } = await fixture();
  const persistence = await openHarnessPersistence(source);
  const limits = { inputTokens: 100, outputTokens: 100, totalTokens: 200 };
  const coordinator = createAgentBudgetCoordinator({ store: persistence.store, scope: source.scope, budgetId: "backup-budget", limits });
  await coordinator.reserve("paid-compaction", { inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  await coordinator.settle("paid-compaction", { inputTokens: 70, outputTokens: 10, totalTokens: 80 });
  const run: AgentRunState = { ...terminalState("budget-run", source.scope), budgetCoordinatorId: coordinator.id,
    compactionRouteFingerprint: "fixture-route-v1", usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 },
    compactionAttempts: [{ id: "compaction-1", beforeStep: 1, sourceDigest: `sha256:${"a".repeat(64)}`, createdAt: 1000,
      status: "confirmed", usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 }, estimatedCost: { amount: 0.001, currency: "USD" },
      route: { provider: "test", modelId: "small", fingerprint: "fixture-route-v1", reservation: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } } }] };
  await persistence.store.save(run);
  persistence.close();
  const bundle = await createHarnessStateBackup(source);
  expect(bundle.records.budgetLedgers).toHaveLength(1);
  expect(bundle.records.runs[0]?.state.compactionAttempts).toEqual(run.compactionAttempts);
  await importHarnessStateBackup(target, bundle);
  const restored = await openHarnessPersistence(target);
  try {
    const loaded = await restored.store.load(run.runId, target.scope);
    expect(loaded?.usage).toEqual(run.usage);
    expect(loaded?.compactionAttempts).toEqual(run.compactionAttempts);
    const resumed = createAgentBudgetCoordinator({ store: restored.store, scope: target.scope, budgetId: "backup-budget", limits });
    await expect(resumed.reserve("new-call", { inputTokens: 31, outputTokens: 1, totalTokens: 32 })).rejects.toThrow("exceeds inputTokens");
    await expect(resumed.reserve("paid-compaction", { inputTokens: 1, outputTokens: 1, totalTokens: 2 })).rejects.toThrow("already reserved");
  } finally { restored.close(); }
  const missing = structuredClone(bundle);
  delete missing.records.budgetLedgers;
  await expect(importHarnessStateBackup(target, withChecksum(missing))).rejects.toThrow("missing its shared budget ledger");
});

test("backup fails closed for in-flight auxiliary calls and unresolved shared budget allocations", async () => {
  const { createAgentBudgetCoordinator } = await import("@zhivex-ai/core");
  const { source } = await fixture();
  const persistence = await openHarnessPersistence(source);
  const coordinator = createAgentBudgetCoordinator({ store: persistence.store, scope: source.scope, budgetId: "unfinished-budget",
    limits: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } });
  await coordinator.reserve("in-flight", { inputTokens: 10, outputTokens: 10, totalTokens: 20 });
  const run: AgentRunState = { ...terminalState("unfinished-run", source.scope), budgetCoordinatorId: coordinator.id };
  await persistence.store.save(run);
  try {
    await expect(createHarnessStateBackup(source)).rejects.toThrow("unresolved reservations");
    await coordinator.settle("in-flight", { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    run.compactionAttempts = [{ id: "unknown-compaction", beforeStep: 1, sourceDigest: `sha256:${"b".repeat(64)}`, createdAt: 1000,
      status: "unknown", route: { provider: "test", modelId: "small", fingerprint: "route", reservation: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } }];
    await persistence.store.save({ ...run, revision: 1 }, { expectedRevision: 0 });
    await expect(createHarnessStateBackup(source)).rejects.toThrow("unresolved auxiliary");
  } finally { persistence.close(); }
});

test("export refuses to silently omit orphan budget ledgers after their run is removed", async () => {
  const { createAgentBudgetCoordinator } = await import("@zhivex-ai/core");
  const { source } = await fixture();
  const persistence = await openHarnessPersistence(source);
  try {
    const coordinator = createAgentBudgetCoordinator({ store: persistence.store, scope: source.scope, budgetId: "orphan-budget",
      limits: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
    await coordinator.reserve("paid", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    await coordinator.settle("paid", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    await expect(createHarnessStateBackup(source)).rejects.toThrow("unlinked shared budget ledger");
  } finally { persistence.close(); }
});
