import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import {
  HARNESS_SESSION_INDEX_FILE,
  openCliSessionStore,
  type CliSessionStore
} from "../src/sessions.js";

const temporaryDirectories: string[] = [];
const openStores: CliSessionStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const fixture = async (options: Partial<Parameters<typeof openCliSessionStore>[0]> = {}) => {
  const workspace = options.workspace ?? await mkdtemp(path.join(os.tmpdir(), "zhivex-session-workspace-"));
  const stateDirectory = options.stateDirectory ?? await mkdtemp(path.join(os.tmpdir(), "zhivex-session-state-"));
  if (!options.workspace) {
    temporaryDirectories.push(workspace);
  }
  if (!options.stateDirectory) {
    temporaryDirectories.push(stateDirectory);
  }
  let timestamp = 1_000;
  const store = await openCliSessionStore({
    workspace,
    stateDirectory,
    scope: { tenantId: "local", namespace: "tests" },
    now: () => timestamp++,
    ...options
  });
  openStores.push(store);
  return { workspace, stateDirectory, store };
};

describe("durable CLI sessions", () => {
  test("persists immutable run bindings and permits provider changes only on a new terminal turn", async () => {
    const { workspace, stateDirectory, store } = await fixture();
    const created = await store.create({
      title: "provider routing",
      initialRun: {
        runId: "run-openai-1",
        provider: "openai",
        model: "gpt-5.4",
        role: "implementer",
        status: "running"
      }
    });

    await expect(store.appendRun(created.sessionId, {
      runId: "run-qwen-1",
      provider: "qwen",
      model: "qwen3.8-max"
    })).rejects.toThrow("while run run-openai-1 is running");

    const completed = await store.updateRun(created.sessionId, "run-openai-1", {
      status: "completed",
      expectedSessionRevision: 0
    });
    expect(completed.revision).toBe(1);

    await expect(store.appendRun(created.sessionId, {
      runId: "run-openai-1",
      provider: "qwen",
      model: "qwen3.8-max",
      status: "completed"
    })).rejects.toThrow("immutably bound to openai/gpt-5.4");

    const switched = await store.appendRun(created.sessionId, {
      runId: "run-qwen-1",
      provider: "qwen",
      model: "qwen3.8-max",
      role: "reviewer",
      status: "completed"
    }, { expectedRevision: 1 });
    expect(switched.runs.map(({ runId, provider, model }) => ({ runId, provider, model }))).toEqual([
      { runId: "run-openai-1", provider: "openai", model: "gpt-5.4" },
      { runId: "run-qwen-1", provider: "qwen", model: "qwen3.8-max" }
    ]);

    store.close();
    openStores.splice(openStores.indexOf(store), 1);
    const reopened = await openCliSessionStore({
      workspace,
      stateDirectory,
      scope: { tenantId: "local", namespace: "tests" }
    });
    openStores.push(reopened);
    expect(await reopened.get(created.sessionId)).toMatchObject({
      title: "provider routing",
      runs: [
        { runId: "run-openai-1", provider: "openai", model: "gpt-5.4", status: "completed" },
        { runId: "run-qwen-1", provider: "qwen", model: "qwen3.8-max", status: "completed" }
      ]
    });
  });

  test("stores only explicit run metadata and redacts operator labels", async () => {
    const { stateDirectory, store } = await fixture();
    const secret = "abcdefgh12345678";
    const created = await store.create({
      title: `deploy api_key=${secret} for person@example.com`,
      initialRun: {
        runId: "safe-run-id",
        provider: "openai",
        model: "gpt-5.4",
        status: "completed"
      }
    });
    expect(created.title).not.toContain(secret);
    expect(created.title).not.toContain("person@example.com");
    expect(created).not.toHaveProperty("messages");
    await expect(store.create({
      initialRun: {
        runId: "another-run",
        provider: "sk-secretvalue123",
        model: "unsafe",
        status: "completed"
      }
    })).rejects.toThrow("resembles sensitive metadata");
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const database = new Database(path.join(stateDirectory, HARNESS_SESSION_INDEX_FILE), { readonly: true });
    try {
      const rows = database.query<{ title: string; run_id: string; provider: string; model: string }, []>(`
        SELECT s.title, r.run_id, r.provider, r.model
        FROM zhivex_cli_sessions s JOIN zhivex_cli_session_runs r ON r.session_id = s.session_id
      `).all();
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(rows).toEqual([{
        title: "deploy [REDACTED] for [REDACTED]",
        run_id: "safe-run-id",
        provider: "openai",
        model: "gpt-5.4"
      }]);
    } finally {
      database.close(false);
    }
  });

  test("isolates latest/list/get by canonical workspace and durable scope", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-workspace-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-workspace-b-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-shared-state-"));
    temporaryDirectories.push(workspaceA, workspaceB, stateDirectory);
    const clock = (() => {
      let timestamp = 10_000;
      return () => timestamp++;
    })();
    const first = await openCliSessionStore({
      workspace: workspaceA,
      stateDirectory,
      scope: { tenantId: "tenant-a", userId: "user-a", namespace: "code" },
      now: clock
    });
    const otherScope = await openCliSessionStore({
      workspace: workspaceA,
      stateDirectory,
      scope: { tenantId: "tenant-b", namespace: "code" },
      now: clock
    });
    const otherWorkspace = await openCliSessionStore({
      workspace: workspaceB,
      stateDirectory,
      scope: { tenantId: "tenant-a", userId: "user-a", namespace: "code" },
      now: clock
    });
    openStores.push(first, otherScope, otherWorkspace);

    const a1 = await first.create({ title: "a1" });
    const a2 = await first.create({ title: "a2" });
    const b = await otherScope.create({ title: "other-scope" });
    await otherWorkspace.create({ title: "other-workspace" });

    expect((await first.latest())?.sessionId).toBe(a2.sessionId);
    expect((await first.list()).map((session) => session.sessionId)).toEqual([a2.sessionId, a1.sessionId]);
    expect(await first.get(b.sessionId)).toBeUndefined();
    expect(first.workspaceKey).not.toBe(otherWorkspace.workspaceKey);
    expect(first.scopeKey).not.toBe(otherScope.scopeKey);
  });

  test("supports optimistic rename, bounded indexes and stable idempotent append", async () => {
    const { store } = await fixture({
      maxSessionsPerWorkspace: 1,
      maxRunsPerSession: 1,
      maxMetadataBytes: 64
    });
    const created = await store.create({ title: "one" });
    const renamed = await store.rename(created.sessionId, "renamed", { expectedRevision: 0 });
    expect(renamed).toMatchObject({ title: "renamed", revision: 1 });
    await expect(store.rename(created.sessionId, "stale", { expectedRevision: 0 }))
      .rejects.toThrow("changed concurrently");
    await expect(store.create({ title: "two" })).rejects.toThrow("Session limit reached");
    await expect(store.rename(created.sessionId, "x".repeat(65))).rejects.toThrow("metadata limit");

    const withRun = await store.appendRun(created.sessionId, {
      runId: "only-run",
      provider: "openai",
      model: "gpt-5.4",
      status: "completed"
    });
    const repeated = await store.appendRun(created.sessionId, {
      runId: "only-run",
      provider: "openai",
      model: "gpt-5.4",
      status: "completed"
    });
    expect(repeated.revision).toBe(withRun.revision);
    await expect(store.appendRun(created.sessionId, {
      runId: "second-run",
      provider: "qwen",
      model: "qwen3.8-max",
      status: "completed"
    })).rejects.toThrow("Run-reference limit");
  });

  test("serializes concurrent writers across SQLite handles with revision checks", async () => {
    const { workspace, stateDirectory, store: first } = await fixture();
    const second = await openCliSessionStore({
      workspace,
      stateDirectory,
      scope: { tenantId: "local", namespace: "tests" }
    });
    openStores.push(second);
    const created = await first.create({ title: "shared" });

    const results = await Promise.allSettled([
      first.rename(created.sessionId, "writer-a", { expectedRevision: 0 }),
      second.rename(created.sessionId, "writer-b", { expectedRevision: 0 })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await first.get(created.sessionId))?.revision).toBe(1);
  });

  test("enforces a byte budget for the scoped session index", async () => {
    const { store } = await fixture({
      maxSessionsPerWorkspace: 20,
      maxMetadataBytes: 128,
      maxIndexBytes: 1_024
    });
    for (let index = 0; index < 10; index += 1) {
      await store.create({ title: `${index}`.padEnd(100, "x") });
    }
    await expect(store.create({ title: "overflow".padEnd(100, "x") }))
      .rejects.toThrow("Session index metadata exceeds the 1024-byte limit");
    expect(await store.list({ limit: 20 })).toHaveLength(10);
  });

  test("forks terminal history, archives safely and prunes only retained tombstones", async () => {
    const { store } = await fixture({ retentionMs: 100 });
    const source = await store.create({
      title: "main",
      initialRun: { runId: "run-1", provider: "openai", model: "gpt-5.4", status: "completed" }
    });
    const sourceWithTwoRuns = await store.appendRun(source.sessionId, {
      runId: "run-2",
      provider: "qwen",
      model: "qwen3.8-max",
      status: "completed"
    });
    const branchPoint = sourceWithTwoRuns.runs[0]!;
    const fork = await store.fork(source.sessionId, { atTurnId: branchPoint.turnId, title: "branch" });
    expect(fork).toMatchObject({
      parentSessionId: source.sessionId,
      forkedFromTurnId: branchPoint.turnId,
      title: "branch"
    });
    expect(fork.runs).toHaveLength(1);
    expect(fork.runs[0]).toMatchObject({ runId: "run-1", sourceTurnId: branchPoint.turnId });

    const archived = await store.archive(fork.sessionId);
    expect(archived.archivedAt).toBeNumber();
    expect((await store.list()).map((session) => session.sessionId)).not.toContain(fork.sessionId);
    expect((await store.list({ includeArchived: true })).map((session) => session.sessionId)).toContain(fork.sessionId);

    const deleted = await store.delete(fork.sessionId, { expectedRevision: archived.revision });
    expect(deleted.deletedAt).toBeNumber();
    expect(await store.get(fork.sessionId)).toBeUndefined();
    expect(await store.get(fork.sessionId, { includeDeleted: true })).toMatchObject({ sessionId: fork.sessionId });

    const result = await store.prune({ before: deleted.updatedAt + 1 });
    expect(result.deletedSessions).toBe(1);
    expect(await store.get(fork.sessionId, { includeDeleted: true })).toBeUndefined();
    expect(await store.get(source.sessionId)).toBeDefined();
  });

  test("rejects forks, archive and logical deletion while the branch point is active", async () => {
    const { store } = await fixture();
    const active = await store.create({
      initialRun: { runId: "active-run", provider: "openai", model: "gpt-5.4", status: "waiting_approval" }
    });
    await expect(store.fork(active.sessionId)).rejects.toThrow("Cannot fork from non-terminal run");
    await expect(store.archive(active.sessionId)).rejects.toThrow("while run active-run is waiting_approval");
    await expect(store.delete(active.sessionId)).rejects.toThrow("while run active-run is waiting_approval");
    expect((await store.get(active.sessionId))?.runs[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      status: "waiting_approval"
    });
  });

  test("rejects symlinked session state and database paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-workspace-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-state-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-outside-"));
    temporaryDirectories.push(workspace, stateDirectory, outside);
    await symlink(outside, path.join(stateDirectory, "linked-state"));

    await expect(openCliSessionStore({
      workspace,
      stateDirectory: path.join(stateDirectory, "linked-state"),
      scope: { tenantId: "local" }
    })).rejects.toThrow("must not be a symbolic link");

    await Bun.write(path.join(outside, "target.sqlite"), "not sqlite");
    await symlink(path.join(outside, "target.sqlite"), path.join(stateDirectory, HARNESS_SESSION_INDEX_FILE));
    await expect(openCliSessionStore({
      workspace,
      stateDirectory,
      scope: { tenantId: "local" }
    })).rejects.toThrow("must be a real file");
    const entry = await lstat(path.join(stateDirectory, HARNESS_SESSION_INDEX_FILE));
    expect(entry.isSymbolicLink()).toBe(true);
  });
});
