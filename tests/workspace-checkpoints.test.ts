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
