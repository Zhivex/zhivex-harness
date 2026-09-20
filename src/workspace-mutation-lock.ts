import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { statRegularFileNoFollow } from "./file-security.js";
import { HarnessStateConflictError, HarnessWorkspaceError } from "./errors.js";
import { SqliteDatabase } from "./sqlite-database.js";

const ownership = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** Cooperative host mutation lock shared across Workspace instances and processes.
 * SQLite releases ownership on process death; no stale-PID lock stealing is used.
 * The host account and writers that bypass Harness remain outside this protocol.
 */
export const withWorkspaceMutation = async <T>(root: string, operation: () => Promise<T>): Promise<T> => {
  root = await realpath(root);
  const inherited = ownership.getStore();
  if (inherited?.get(root)?.active) return operation();
  const uid = process.getuid?.();
  if (uid === undefined || !["darwin", "linux"].includes(process.platform)) {
    throw new HarnessWorkspaceError("Workspace mutation locks require Linux or macOS user identity.");
  }
  // Outside the repository: coordination must not itself modify the reviewed
  // tree, and must not depend on a caller-selected state directory or TMPDIR.
  const directory = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp",
    `zhivex-harness-mutation-locks-${uid}`);
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new HarnessWorkspaceError("Workspace mutation lock requires a real state directory without symbolic links.");
  }
  const filename = path.join(directory, `${createHash("sha256").update(root).digest("hex")}.sqlite`);
  try { const created = await open(filename, "wx", 0o600); await created.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const before = await statRegularFileNoFollow(filename, { label: "Workspace mutation lock", requireSingleLink: true });
  if (before.uid !== uid || (before.mode & 0o077) !== 0) throw new HarnessWorkspaceError("Workspace mutation lock must be owner-only.");
  const database = new SqliteDatabase(filename, { create: false });
  let acquired = false;
  const token = { active: true };
  try {
    const after = await statRegularFileNoFollow(filename, { label: "Workspace mutation lock", requireSingleLink: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new HarnessWorkspaceError("Workspace mutation lock changed while opening.");
    }
    database.exec("PRAGMA busy_timeout = 0");
    const deadline = performance.now() + 15_000;
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); acquired = true; break; }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/database (?:is )?(?:locked|busy)/i.test(message)) throw error;
        if (performance.now() >= deadline) throw new HarnessStateConflictError("Workspace mutation is owned by another writer.");
        await delay(25);
      }
    }
    return await ownership.run(new Map([...(inherited ?? []), [root, token]]), operation);
  } finally {
    token.active = false;
    try { if (acquired) database.exec("ROLLBACK"); }
    finally { database.close(false); }
  }
};
