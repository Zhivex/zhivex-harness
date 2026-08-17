import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunState } from "@zhivex-ai/agents";
import { createFileAgentRunStore } from "@zhivex-ai/agents/ops";

import { resolveHarnessConfig } from "../src/config.js";
import {
  HARNESS_SQLITE_FILE,
  cancelHarnessRun,
  cleanupHarnessRuns,
  inspectHarnessRun,
  listHarnessRuns,
  openHarnessPersistence
} from "../src/operations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const state = (runId: string, updatedAt = Date.now()): AgentRunState => ({
  schemaVersion: 1,
  revision: 0,
  runId,
  provider: "mock-provider",
  modelId: "mock-model",
  status: "completed",
  messages: [],
  steps: [],
  toolResults: [],
  currentStep: 0,
  maxSteps: 12,
  outputText: "secret token=abcdefgh12345678",
  pendingApprovals: [],
  compactions: [],
  startedAt: updatedAt - 10,
  updatedAt
});

describe("durable operations", () => {
  test("migrates 0.3 file runs into scoped SQLite and exposes redacted operations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    temporaryDirectories.push(workspace, stateDirectory);
    const legacyStore = createFileAgentRunStore({ directory: stateDirectory });
    await legacyStore.save(state("legacy-run", 100));

    const config = resolveHarnessConfig({ workspace, stateDirectory, storeBackend: "sqlite" });
    const persistence = await openHarnessPersistence(config);
    try {
      expect(persistence.backend).toBe("sqlite");
      expect(persistence.migration).toMatchObject({ scannedRuns: 1, migratedRuns: 1 });
      const sqliteEntry = await lstat(path.join(stateDirectory, HARNESS_SQLITE_FILE));
      expect(sqliteEntry.isFile()).toBe(true);
      expect(sqliteEntry.mode & 0o777).toBe(0o600);

      const listed = await listHarnessRuns(persistence.store, config);
      expect(listed.runs).toContainEqual(expect.objectContaining({
        runId: "legacy-run",
        status: "completed",
        scope: config.scope
      }));

      const inspected = await inspectHarnessRun(persistence.store, config, "legacy-run");
      expect(inspected.kind).toBe("run-inspection");
      expect(JSON.stringify(inspected)).not.toContain("abcdefgh12345678");
      expect(inspected.snapshot).not.toHaveProperty("outputText");
      expect(inspected.ledger.snapshot).not.toHaveProperty("outputText");

      const cancelled = await cancelHarnessRun(persistence.store, config, "legacy-run", {
        reason: "operator request"
      });
      expect(cancelled).toMatchObject({
        kind: "run-cancellation",
        run: { status: "cancel_requested", cancellationReason: "operator request" }
      });

      const cleanup = await cleanupHarnessRuns(persistence.store, config, {
        before: Date.now() + 1_000,
        statuses: ["cancel_requested"]
      });
      expect(cleanup.deleted).toBe(1);
      expect((await listHarnessRuns(persistence.store, config)).runs).toEqual([]);
    } finally {
      persistence.close();
      persistence.close();
    }
  });

  test("atomically reuses idempotency claims across SQLite reopen", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    temporaryDirectories.push(workspace, stateDirectory);
    const config = resolveHarnessConfig({ workspace, stateDirectory });
    const first = await openHarnessPersistence(config);
    const candidate = {
      ...state("idempotent-run"),
      scope: config.scope,
      idempotencyKey: "request-42"
    };
    const initial = await first.store.claimIdempotencyKey?.(candidate);
    expect(initial?.claimed).toBe(true);
    first.close();

    const second = await openHarnessPersistence(config);
    try {
      const duplicate = await second.store.claimIdempotencyKey?.({
        ...candidate,
        runId: "duplicate-run"
      });
      expect(duplicate).toMatchObject({ claimed: false, state: { runId: "idempotent-run" } });
    } finally {
      second.close();
    }
  });

  test("keeps the file backend as a scoped legacy migration path", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    temporaryDirectories.push(workspace, stateDirectory);
    await createFileAgentRunStore({ directory: stateDirectory }).save(state("legacy-file-run"));

    const config = resolveHarnessConfig({ workspace, stateDirectory, storeBackend: "file" });
    const persistence = await openHarnessPersistence(config);
    expect(persistence.migration).toMatchObject({ scannedRuns: 1, migratedRuns: 1 });
    expect(await persistence.store.load("legacy-file-run", config.scope)).toMatchObject({
      runId: "legacy-file-run",
      scope: config.scope,
      metadata: { migratedFrom: "0.3-file-store" }
    });
  });

  test("does not copy unscoped legacy data into a custom scope implicitly", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    temporaryDirectories.push(workspace, stateDirectory);
    await createFileAgentRunStore({ directory: stateDirectory }).save(state("legacy-private-run"));

    const config = resolveHarnessConfig({
      workspace,
      stateDirectory,
      tenantId: "tenant-a",
      namespace: "payments"
    });
    const persistence = await openHarnessPersistence(config);
    try {
      expect(persistence.migration).toEqual({ scannedRuns: 0, migratedRuns: 0, migratedToolCalls: 0 });
      expect(await persistence.store.load("legacy-private-run", config.scope)).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  test("serializes concurrent idempotency claims and recovers expired leases", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    temporaryDirectories.push(workspace, stateDirectory);
    const config = resolveHarnessConfig({ workspace, stateDirectory });
    const persistence = await openHarnessPersistence(config);
    try {
      const claims = await Promise.all(["concurrent-a", "concurrent-b"].map((runId) =>
        persistence.store.claimIdempotencyKey?.({
          ...state(runId),
          scope: config.scope,
          idempotencyKey: "same-request"
        })
      ));
      expect(claims.filter((claim) => claim?.claimed)).toHaveLength(1);
      expect(new Set(claims.map((claim) => claim?.state.runId)).size).toBe(1);

      const runId = claims[0]?.state.runId;
      expect(runId).toBeString();
      const firstLease = await persistence.store.acquireLease?.(runId!, {
        ownerId: "worker-a",
        ttlMs: 100,
        now: 1_000
      }, config.scope);
      expect(firstLease).toMatchObject({ ownerId: "worker-a", expiresAt: 1_100 });
      expect(await persistence.store.acquireLease?.(runId!, {
        ownerId: "worker-b",
        ttlMs: 100,
        now: 1_050
      }, config.scope)).toBeUndefined();
      expect(await persistence.store.acquireLease?.(runId!, {
        ownerId: "worker-b",
        ttlMs: 100,
        now: 1_101
      }, config.scope)).toMatchObject({ ownerId: "worker-b", expiresAt: 1_201 });
    } finally {
      persistence.close();
    }
  });

  test("rejects a symlinked SQLite state file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-state-"));
    const target = path.join(stateDirectory, "outside.sqlite");
    temporaryDirectories.push(workspace, stateDirectory);
    await Bun.write(target, "not a database");
    await symlink(target, path.join(stateDirectory, HARNESS_SQLITE_FILE));

    const config = resolveHarnessConfig({ workspace, stateDirectory });
    await expect(openHarnessPersistence(config)).rejects.toThrow("real file");
  });

  test("keeps the public persistence helper from targeting the workspace root", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-operations-workspace-"));
    temporaryDirectories.push(workspace);
    const config = resolveHarnessConfig({ workspace, stateDirectory: workspace });
    await expect(openHarnessPersistence(config)).rejects.toThrow("workspace or filesystem root");
  });
});
