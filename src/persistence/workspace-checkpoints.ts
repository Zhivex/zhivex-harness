import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Workspace } from "../workspace/workspace.js";
import { readRegularFileNoFollow, statRegularFileNoFollow } from "../workspace/file-security.js";
import { withWorkspaceMutation } from "../workspace/workspace-mutation-lock.js";
import { createEditProposal, fileDigestSchema, workspaceFilePathSchema, type FileDigest } from "../workspace/edit-contracts.js";
import { SqliteDatabase } from "./sqlite-database.js";
import { TERMINAL_SESSION_RUN_STATUSES, type CliSessionStore } from "./sessions.js";

const fileSchema = z.strictObject({ path: workspaceFilePathSchema, digest: fileDigestSchema,
  content: z.string().max(65536), mode: z.number().int().min(0).max(0o777) }).refine((file) =>
    Buffer.byteLength(file.content) <= 65536 && !file.content.includes("\0") &&
    file.digest === `sha256:${createHash("sha256").update(file.content).digest("hex")}`, "Invalid checkpoint content identity.");
export const workspaceCheckpointSchema = z.strictObject({ id: z.string().uuid(), sessionId: z.string(), turnId: z.string(),
  files: z.array(fileSchema).min(1).max(20) });
export const workspaceRestoreOperationSchema = z.strictObject({ id: z.string().uuid(), checkpoint: workspaceCheckpointSchema,
  proposalId: fileDigestSchema, expected: z.record(z.string(), fileDigestSchema),
  stage: z.enum(["prepared", "forking", "forked", "applying", "applied", "completed"]), forkSessionId: z.string().optional() });
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
export type WorkspaceRestoreOperation = z.infer<typeof workspaceRestoreOperationSchema>;
const digest = (content: string | Buffer): FileDigest => `sha256:${createHash("sha256").update(content).digest("hex")}`;

/** Existing text files only. No deletion, creation, binary file, or mode rollback. */
export const openWorkspaceCheckpointStore = async (workspace: Workspace, sessions: CliSessionStore) => {
  const key = createHash("sha256").update("workspace\0").update(workspace.root).digest("hex");
  if (key !== sessions.workspaceKey) throw new Error("Checkpoint session store belongs to a different workspace.");
  const before = await statRegularFileNoFollow(sessions.databasePath, { label: "Checkpoint database", requireSingleLink: true });
  if (before.uid !== process.getuid?.() || (before.mode & 0o077)) throw new Error("Checkpoint database must be private.");
  const db = new SqliteDatabase(sessions.databasePath, { create: false });
  const after = await statRegularFileNoFollow(sessions.databasePath, { label: "Checkpoint database", requireSingleLink: true });
  if (before.dev !== after.dev || before.ino !== after.ino) { db.close(); throw new Error("Checkpoint database changed."); }
  db.exec("CREATE TABLE IF NOT EXISTS zhivex_workspace_checkpoints (id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)");
  const save = (kind: string, value: { id: string }) => {
    const existing = db.query<{ id: string }>("SELECT id FROM zhivex_workspace_checkpoints WHERE id=?").get(value.id);
    const count = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM zhivex_workspace_checkpoints WHERE workspace_key=? AND scope_key=?").get(sessions.workspaceKey, sessions.scopeKey)?.count ?? 0;
    if (!existing && count >= 100) throw new Error("Checkpoint scope storage limit reached (100 records).");
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("Checkpoint exceeds storage limit.");
    db.query("INSERT INTO zhivex_workspace_checkpoints(id, workspace_key, scope_key, kind, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE workspace_key=excluded.workspace_key AND scope_key=excluded.scope_key AND kind=excluded.kind")
      .run(value.id, sessions.workspaceKey, sessions.scopeKey, kind, body);
  };
  const load = (kind: string, id: string) => {
    const row = db.query<{ body: string }>("SELECT body FROM zhivex_workspace_checkpoints WHERE id=? AND workspace_key=? AND scope_key=? AND kind=?")
      .get(id, sessions.workspaceKey, sessions.scopeKey, kind);
    if (!row) throw new Error("Unknown checkpoint or restore operation in this scope.");
    return JSON.parse(row.body) as unknown;
  };
  const read = async (target: string) => {
    const authorized = await workspace.readFile(target, 1, 1);
    const { contents, stat } = await readRegularFileNoFollow(path.join(workspace.root, target), {
      label: "Checkpoint target", maxBytes: 65536, requireSingleLink: true });
    const content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    if (contents.includes(0) || digest(contents) !== authorized.digest) throw new Error("Checkpoint file changed while reading.");
    return fileSchema.parse({ path: target, digest: digest(contents), content, mode: stat.mode & 0o777 });
  };
  const validateTurn = async (checkpoint: Pick<WorkspaceCheckpoint, "sessionId" | "turnId">) => {
    const session = await sessions.get(checkpoint.sessionId);
    const run = session?.runs.find((entry) => entry.turnId === checkpoint.turnId);
    if (!session || !run || !(TERMINAL_SESSION_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new Error("Checkpoint requires an existing terminal conversation turn.");
    }
    return session;
  };
  const proposal = (operation: WorkspaceRestoreOperation) => {
    if (new Set(operation.checkpoint.files.map((file) => file.path)).size !== operation.checkpoint.files.length ||
      operation.checkpoint.files.some((file) => digest(file.content) !== file.digest)) throw new Error("Checkpoint content identity is corrupt.");
    const changes = operation.checkpoint.files.map((file) => ({ path: file.path, expectedDigest: operation.expected[file.path]!, content: file.content }));
    const result = createEditProposal({ changes });
    if (result.proposalId !== operation.proposalId) throw new Error("Restore proposal identity is corrupt.");
    return { proposalId: result.proposalId, changes };
  };
  const getOperation = (id: string) => workspaceRestoreOperationSchema.parse(load("restore", id));
  return {
    close: () => db.close(),
    getCheckpoint: (id: string) => workspaceCheckpointSchema.parse(load("checkpoint", id)),
    getOperation,
    capture: async (input: { sessionId: string; turnId: string; paths: readonly string[] }): Promise<WorkspaceCheckpoint> => withWorkspaceMutation(workspace.root, async () => {
      await validateTurn(input);
      if (input.paths.length === 0 || input.paths.length > 20 || new Set(input.paths).size !== input.paths.length) throw new Error("Capture requires 1 to 20 unique existing text files.");
      const files = [];
      for (const target of input.paths) files.push(await read(target));
      const checkpoint = workspaceCheckpointSchema.parse({ id: randomUUID(), sessionId: input.sessionId, turnId: input.turnId, files });
      save("checkpoint", checkpoint);
      return checkpoint;
    }),
    prepareRestore: async (checkpointId: string, expectedCurrent: Readonly<Record<string, FileDigest>>) => withWorkspaceMutation(workspace.root, async () => {
      const checkpoint = workspaceCheckpointSchema.parse(load("checkpoint", checkpointId));
      await validateTurn(checkpoint);
      if (Object.keys(expectedCurrent).length !== checkpoint.files.length) throw new Error("Provide exact post-agent digests for every captured file.");
      for (const file of checkpoint.files) {
        const current = await read(file.path);
        if (current.digest !== expectedCurrent[file.path] || current.mode !== file.mode) throw new Error(`Restore conflicts with current content or mode: ${file.path}.`);
      }
      const changes = checkpoint.files.map((file) => ({ path: file.path, expectedDigest: expectedCurrent[file.path], content: file.content }));
      const preview = createEditProposal({ changes });
      const operation = workspaceRestoreOperationSchema.parse({ id: randomUUID(), checkpoint, proposalId: preview.proposalId,
        expected: expectedCurrent, stage: "prepared" });
      save("restore", operation);
      return { operation, proposal: { ...preview, changes } };
    }),
    /** Trusted operator invocation after reviewing this exact proposal ID. */
    applyRestore: async (id: string, reviewedProposalId: FileDigest) => withWorkspaceMutation(workspace.root, async () => {
      const operation = getOperation(id);
      if (operation.proposalId !== reviewedProposalId) throw new Error("Restore requires the reviewed proposal identity.");
      const patch = proposal(operation);
      if (operation.stage === "completed") return operation;
      if (operation.stage === "forking") throw new Error(`Fork outcome uncertain. Inspect child sessions titled restore:${operation.id} and call recoverFork with the exact child ID; no files changed.`);
      const current = [];
      for (const file of operation.checkpoint.files) {
        const found = await read(file.path);
        if (found.mode !== file.mode) throw new Error(`Restore mode conflict: ${file.path}.`);
        current.push(found);
      }
      const beforeApply = current.every((file) => file.digest === operation.expected[file.path]);
      const afterApply = current.every((file) => file.digest === operation.checkpoint.files.find((entry) => entry.path === file.path)?.digest);
      if (["applying", "applied"].includes(operation.stage) && afterApply) {
        operation.stage = "completed"; save("restore", operation); return operation;
      }
      if (!beforeApply || operation.stage === "applied") throw new Error("Restore conflicts with subsequent edits or a partially applied filesystem operation; manual recovery required.");
      if (operation.stage === "prepared") {
        const source = await validateTurn(operation.checkpoint);
        operation.stage = "forking"; save("restore", operation);
        const fork = await sessions.fork(source.sessionId, { atTurnId: operation.checkpoint.turnId,
          expectedRevision: source.revision, title: `restore:${operation.id}` });
        operation.forkSessionId = fork.sessionId; operation.stage = "forked"; save("restore", operation);
      }
      if (!operation.forkSessionId) throw new Error("Restore has no recorded conversation fork.");
      operation.stage = "applying"; save("restore", operation);
      await workspace.applyPatchWithModes(patch, new Map(operation.checkpoint.files.map((file) => [file.path, { beforeMode: file.mode, afterMode: file.mode }])));
      operation.stage = "applied"; save("restore", operation);
      operation.stage = "completed"; save("restore", operation);
      return operation;
    }),
    /** Resolve only the uncertain fork window; never creates another fork. */
    recoverFork: async (id: string, forkSessionId: string) => withWorkspaceMutation(workspace.root, async () => {
      const operation = getOperation(id);
      const fork = await sessions.get(forkSessionId);
      if (operation.stage !== "forking" || !fork || fork.parentSessionId !== operation.checkpoint.sessionId ||
        fork.forkedFromTurnId !== operation.checkpoint.turnId || fork.title !== `restore:${operation.id}`) throw new Error("Fork does not match this interrupted restore.");
      operation.forkSessionId = forkSessionId; operation.stage = "forked"; save("restore", operation);
      return operation;
    })
  };
};
