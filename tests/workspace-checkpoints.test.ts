import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Workspace } from "../src/workspace/workspace.js";
import { openCliSessionStore } from "../src/persistence/sessions.js";
import { openWorkspaceCheckpointStore } from "../src/persistence/workspace-checkpoints.js";

const fixture = async (run: (value: { workspace: Workspace; sessions: Awaited<ReturnType<typeof openCliSessionStore>>;
  checkpoints: Awaited<ReturnType<typeof openWorkspaceCheckpointStore>>; sessionId: string; turnId: string }) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-checkpoint-"));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-checkpoint-state-"));
  const workspace = await Workspace.open(root);
  const sessions = await openCliSessionStore({ workspace: root, stateDirectory, scope: { tenantId: "local", namespace: "tests" } });
  const checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
  try {
    const session = await sessions.create({ initialRun: { runId: "run-test", provider: "test", model: "test", status: "completed" } });
    await writeFile(path.join(root, "a.txt"), "original");
    await run({ workspace, sessions, checkpoints, sessionId: session.sessionId, turnId: session.runs[0]!.turnId });
  } finally { checkpoints.close(); sessions.close(); await rm(root, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true }); }
};

test("restores reviewed existing files and forks terminal conversation, idempotently", () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const checkpoint = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await writeFile(path.join(workspace.root, "a.txt"), "agent edit");
  const current = await workspace.readFile("a.txt");
  const prepared = await checkpoints.prepareRestore(checkpoint.id, { "a.txt": current.digest });
  expect(prepared.proposal.changes[0]?.content).toBe("original");
  const complete = await checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId);
  expect(complete.stage).toBe("completed");
  expect((await sessions.get(complete.forkSessionId!))?.parentSessionId).toBe(sessionId);
  expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("original");
  expect(await checkpoints.applyRestore(complete.id, complete.proposalId)).toEqual(complete);
  expect(await sessions.get(sessionId)).toBeDefined();
}));

test("rejects user changes after review, missing files, modes, and nonterminal turns", () => fixture(async ({ workspace, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  const current = await workspace.readFile("a.txt");
  const prepared = await checkpoints.prepareRestore(captured.id, { "a.txt": current.digest });
  await writeFile(path.join(workspace.root, "a.txt"), "user edit");
  await expect(checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId)).rejects.toThrow("conflicts");
  await expect(checkpoints.capture({ sessionId, turnId: "missing", paths: ["a.txt"] })).rejects.toThrow("terminal");
  await chmod(path.join(workspace.root, "a.txt"), 0o700);
  await expect(checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest })).rejects.toThrow("mode");
  await rm(path.join(workspace.root, "a.txt"));
  await expect(checkpoints.prepareRestore(captured.id, { "a.txt": current.digest })).rejects.toThrow();
}));

test("interrupted fork is explicitly reconciled and applying state verifies digests", () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await writeFile(path.join(workspace.root, "a.txt"), "changed");
  const prepared = await checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
  const db = new DatabaseSync(sessions.databasePath);
  try {
    db.prepare("UPDATE zhivex_workspace_checkpoints SET body=? WHERE id=?").run(JSON.stringify({ ...prepared.operation, stage: "forking" }), prepared.operation.id);
    await expect(checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId)).rejects.toThrow("Fork outcome uncertain");
    const fork = await sessions.fork(sessionId, { atTurnId: turnId, title: `restore:${prepared.operation.id}` });
    const recovered = await checkpoints.recoverFork(prepared.operation.id, fork.sessionId);
    // Simulate crash after filesystem commit but before final journal write.
    await writeFile(path.join(workspace.root, "a.txt"), "original");
    db.prepare("UPDATE zhivex_workspace_checkpoints SET body=? WHERE id=?").run(JSON.stringify({ ...recovered, stage: "applying" }), recovered.id);
    expect((await checkpoints.applyRestore(recovered.id, recovered.proposalId)).stage).toBe("completed");
  } finally { db.close(); }
}));

test("failure after durable fork keeps the fork and safely retries the same reviewed patch", () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await writeFile(path.join(workspace.root, "a.txt"), "agent change");
  const prepared = await checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
  const original = workspace.applyPatchWithModes.bind(workspace);
  workspace.applyPatchWithModes = async () => { throw new Error("Injected filesystem failure"); };
  await expect(checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId)).rejects.toThrow("Injected");
  const interrupted = checkpoints.getOperation(prepared.operation.id);
  expect(interrupted.stage).toBe("applying");
  expect(interrupted.forkSessionId).toBeDefined();
  workspace.applyPatchWithModes = original;
  const complete = await checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId);
  expect(complete.forkSessionId).toBe(interrupted.forkSessionId);
  expect((await sessions.list()).filter((entry) => entry.parentSessionId === sessionId)).toHaveLength(1);
  expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("original");
}));

test("uncooperative write during asynchronous fork is caught by final patch preconditions", () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await writeFile(path.join(workspace.root, "a.txt"), "agent change");
  const prepared = await checkpoints.prepareRestore(captured.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
  const original = sessions.fork.bind(sessions);
  sessions.fork = async (...args) => {
    const fork = await original(...args);
    await writeFile(path.join(workspace.root, "a.txt"), "external user edit");
    return fork;
  };
  await expect(checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId)).rejects.toThrow();
  expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("external user edit");
  await expect(checkpoints.applyRestore(prepared.operation.id, prepared.operation.proposalId)).rejects.toThrow("conflicts");
}));

test("checkpoint discovery and exact review survive reopening without effects or content in listings", () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await writeFile(path.join(workspace.root, "a.txt"), "new content for review");
  const reopened = await openWorkspaceCheckpointStore(workspace, sessions);
  try {
    const listing = reopened.listCheckpoints(sessionId);
    expect(listing.map(value => value.id)).toEqual([captured.id]);
    expect(JSON.stringify(listing)).not.toContain("original");
    expect(reopened.listCheckpoints("another-session")).toEqual([]);
    const inspection = await reopened.inspectCheckpoint(captured.id);
    expect(inspection.coverage.fullWorkspaceSnapshot).toBe(false);
    const file = inspection.files[0]!;
    if (file.status !== "available") throw new Error("Expected available file");
    expect(file.before).toBe("new content for review");
    expect(file.after).toBe("original");
    const prepared = await reopened.prepareRestore(captured.id, { "a.txt": file.expectedDigest });
    const preview = await reopened.previewRestore(prepared.operation.id);
    expect(preview.proposalId).toBe(prepared.operation.proposalId);
    expect(preview.files[0]?.before).toBe(file.before);
    expect(preview.files[0]?.after).toBe(file.after);
    expect(reopened.listRestores(sessionId)).toEqual([{ id: prepared.operation.id, checkpointId: captured.id,
      proposalId: prepared.operation.proposalId, stage: "prepared" }]);
    expect(reopened.listRestores("another-session")).toEqual([]);
    expect((await sessions.list()).filter(session => session.parentSessionId === sessionId)).toHaveLength(0);
    expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe(file.before);
    await writeFile(path.join(workspace.root, "a.txt"), "foreign edit after review");
    await expect(reopened.previewRestore(prepared.operation.id)).rejects.toThrow();
    await expect(reopened.applyRestore(prepared.operation.id, preview.proposalId)).rejects.toThrow();
    expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("foreign edit after review");
  } finally { reopened.close(); }
}));

test("inspection reports excluded files and modes without restoring missing or binary content", () => fixture(async ({ workspace, checkpoints, sessionId, turnId }) => {
  const captured = await checkpoints.capture({ sessionId, turnId, paths: ["a.txt"] });
  await chmod(path.join(workspace.root, "a.txt"), 0o700);
  expect((await checkpoints.inspectCheckpoint(captured.id)).files[0]?.status).toBe("mode-conflict");
  await chmod(path.join(workspace.root, "a.txt"), captured.files[0]!.mode);
  await writeFile(path.join(workspace.root, "a.txt"), Buffer.from([0, 255, 1]));
  expect((await checkpoints.inspectCheckpoint(captured.id)).files[0]?.status).toBe("unavailable");
  await rm(path.join(workspace.root, "a.txt"));
  expect((await checkpoints.inspectCheckpoint(captured.id)).files[0]?.status).toBe("unavailable");
  await expect(readFile(path.join(workspace.root, "a.txt"))).rejects.toThrow();
}));

test("prepared restore reopens with the session store, preserves its source and replays without another fork", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-checkpoint-reopen-"));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-checkpoint-reopen-state-"));
  const workspace = await Workspace.open(root);
  const options = { workspace: root, stateDirectory, scope: { tenantId: "local", namespace: "restart" } };
  let sessions = await openCliSessionStore(options);
  let checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
  try {
    await writeFile(path.join(root, "a.txt"), "original");
    const source = await sessions.create({ initialRun: { runId: "restart-run", provider: "test", model: "test", status: "completed" } });
    const checkpoint = await checkpoints.capture({ sessionId: source.sessionId, turnId: source.runs[0]!.turnId, paths: ["a.txt"] });
    await writeFile(path.join(root, "a.txt"), "changed");
    const prepared = await checkpoints.prepareRestore(checkpoint.id, { "a.txt": (await workspace.readFile("a.txt")).digest });
    checkpoints.close(); sessions.close();
    sessions = await openCliSessionStore(options); checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
    expect(checkpoints.listRestores(source.sessionId)[0]?.id).toBe(prepared.operation.id);
    const preview = await checkpoints.previewRestore(prepared.operation.id);
    const completed = await checkpoints.applyRestore(prepared.operation.id, preview.proposalId);
    expect(await sessions.get(source.sessionId)).toEqual(source);
    expect((await sessions.get(completed.forkSessionId!))?.parentSessionId).toBe(source.sessionId);
    checkpoints.close(); sessions.close();
    sessions = await openCliSessionStore(options); checkpoints = await openWorkspaceCheckpointStore(workspace, sessions);
    expect(await checkpoints.applyRestore(completed.id, completed.proposalId)).toEqual(completed);
    expect((await sessions.list()).filter(session => session.parentSessionId === source.sessionId)).toHaveLength(1);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("original");
  } finally {
    checkpoints.close(); sessions.close();
    await rm(root, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('retention protects shared references and pending evidence, removes only reviewed completed records', () => fixture(async ({ workspace, sessions, checkpoints, sessionId, turnId }) => {
  const checkpoint = await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] });
  const expected = { 'a.txt': (await workspace.readFile('a.txt')).digest };
  const first = await checkpoints.prepareRestore(checkpoint.id, expected);
  const second = await checkpoints.prepareRestore(checkpoint.id, expected);
  expect(checkpoints.storageStatus()).toMatchObject({ records: 3, pendingRestores: 2, automaticEviction: false });
  expect(() => checkpoints.prepareRetention({ checkpointIds: [checkpoint.id], completedRestoreIds: [] })).toThrow('referenced');
  expect(() => checkpoints.prepareRetention({ checkpointIds: [], completedRestoreIds: [first.operation.id] })).toThrow('pending');
  await checkpoints.applyRestore(first.operation.id, first.operation.proposalId);
  const completed = checkpoints.prepareRetention({ checkpointIds: [], completedRestoreIds: [first.operation.id] });
  await checkpoints.applyRetention(completed.selection, completed.planId);
  expect(checkpoints.storageStatus()).toMatchObject({ records: 2, pendingRestores: 1 });
  expect(() => checkpoints.prepareRetention({ checkpointIds: [checkpoint.id], completedRestoreIds: [] })).toThrow('referenced');
  await checkpoints.applyRestore(second.operation.id, second.operation.proposalId);
  const before = await sessions.list();
  const removal = checkpoints.prepareRetention({ checkpointIds: [checkpoint.id], completedRestoreIds: [second.operation.id] });
  expect(removal).toMatchObject({ recordsBefore: 2, recordsAfter: 0, workspaceFilesChanged: false, conversationsChanged: false });
  await checkpoints.applyRetention(removal.selection, removal.planId);
  expect(checkpoints.storageStatus().records).toBe(0);
  expect(await sessions.list()).toEqual(before);
  expect(await readFile(path.join(workspace.root, 'a.txt'), 'utf8')).toBe('original');
}));

test('retention invalidates stale reviews including newly added references and never partially deletes', () => fixture(async ({ workspace, checkpoints, sessionId, turnId }) => {
  const one = await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] });
  const two = await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] });
  const plan = checkpoints.prepareRetention({ checkpointIds: [one.id, two.id], completedRestoreIds: [] });
  await checkpoints.prepareRestore(two.id, { 'a.txt': (await workspace.readFile('a.txt')).digest });
  await expect(checkpoints.applyRetention(plan.selection, plan.planId)).rejects.toThrow('referenced');
  expect(checkpoints.listCheckpoints(sessionId)).toHaveLength(2);
  const fresh = checkpoints.prepareRetention({ checkpointIds: [one.id], completedRestoreIds: [] });
  await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] });
  await expect(checkpoints.applyRetention(fresh.selection, fresh.planId)).rejects.toThrow('changed');
  expect(checkpoints.storageStatus().records).toBe(4);
  const reviewed = checkpoints.prepareRetention(fresh.selection);
  await expect(checkpoints.applyRetention(reviewed.selection, `sha256:${'0'.repeat(64)}`)).rejects.toThrow('reviewed');
  expect(checkpoints.storageStatus().records).toBe(4);
}));

test('capacity remains bounded and explicit removal frees space without automatic eviction', () => fixture(async ({ workspace, checkpoints, sessionId, turnId }) => {
  const ids: string[] = [];
  for (let index = 0; index < 100; index++) ids.push((await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] })).id);
  expect(checkpoints.storageStatus()).toMatchObject({ records: 100, availableRecords: 0, maxRecords: 100 });
  await expect(checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] })).rejects.toThrow('limit');
  await expect(checkpoints.prepareRestore(ids[0]!, { 'a.txt': (await workspace.readFile('a.txt')).digest })).rejects.toThrow('limit');
  expect(checkpoints.listCheckpoints(sessionId)).toHaveLength(100);
  const plan = checkpoints.prepareRetention({ checkpointIds: ids.slice(-2), completedRestoreIds: [] });
  await checkpoints.applyRetention(plan.selection, plan.planId);
  const restore = await checkpoints.prepareRestore(ids[0]!, { 'a.txt': (await workspace.readFile('a.txt')).digest });
  await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] });
  // Updating an existing operation can still finish when the scope is full.
  expect((await checkpoints.applyRestore(restore.operation.id, restore.operation.proposalId)).stage).toBe('completed');
  expect(checkpoints.storageStatus()).toMatchObject({ records: 100, pendingRestores: 0 });
}));

test('failure during retention rolls back the entire reviewed selection', () => fixture(async ({ sessions, checkpoints, sessionId, turnId }) => {
  const ids = [];
  for (let index = 0; index < 2; index++) ids.push((await checkpoints.capture({ sessionId, turnId, paths: ['a.txt'] })).id);
  const plan = checkpoints.prepareRetention({ checkpointIds: ids, completedRestoreIds: [] });
  const db = new DatabaseSync(sessions.databasePath);
  try {
    const second = [...ids].sort()[1]!;
    db.exec(`CREATE TRIGGER fail_retention BEFORE DELETE ON zhivex_workspace_checkpoints WHEN OLD.id='${second}' BEGIN SELECT RAISE(ABORT,'retention-injected-failure'); END`);
    await expect(checkpoints.applyRetention(plan.selection, plan.planId)).rejects.toThrow('retention-injected-failure');
    expect(checkpoints.listCheckpoints(sessionId).map(value => value.id).sort()).toEqual([...ids].sort());
    db.exec('DROP TRIGGER fail_retention');
    await checkpoints.applyRetention(plan.selection, plan.planId);
    expect(checkpoints.storageStatus().records).toBe(0);
  } finally { db.close(); }
}));
