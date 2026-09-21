import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {chmod, lstat, mkdir, mkdtemp, open, realpath, rm} from "node:fs/promises";
import path from "node:path";
import type {HarnessConfig} from "../../src/config.js";
import {readRegularFileNoFollow, statRegularFileNoFollow} from "../../src/file-security.js";
import {HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {createHarnessStateBackup} from "../../src/state-backup.js";
import {validateStateDirectory} from "../../src/state-directory.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";

export const DESKTOP_DATABASE_BACKUP_LIMIT = 128 * 1024 * 1024;
export interface DesktopDatabaseBackup {directory: string; size: number; sha256: string; logicalChecksum: string}
function assertIdle(db: SqliteDatabase) {
 const terminal = "('completed','failed','cancelled','timed_out')";
 // Unlike a scope-specific logical export, a whole-file snapshot includes ALL scopes.
 if (db.query<{n: number}>(`SELECT count(*) AS n FROM zhivex_agent_runs WHERE json_extract(state_json,'$.status') IS NULL OR json_extract(state_json,'$.status') NOT IN ${terminal} OR coalesce(json_array_length(json_extract(state_json,'$.pendingApprovals')),0)>0`).get()!.n ||
     db.query<{n: number}, [number]>("SELECT count(*) AS n FROM zhivex_agent_runs_leases WHERE expires_at_ms > ?").get(Date.now())!.n ||
     db.query<{n: number}>(`SELECT count(*) AS n FROM zhivex_cli_session_runs WHERE status NOT IN ${terminal}`).get()!.n ||
     db.query<{n: number}>("SELECT count(*) AS n FROM zhivex_agent_runs_tool_journal WHERE json_extract(entry_json,'$.status') IS NULL OR json_extract(entry_json,'$.status') NOT IN ('completed','failed')").get()!.n) throw new Error("BACKUP_WORK_ACTIVE");
}
async function privateDirectory(directory: string) {
 const stat = await lstat(directory);
 if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
 return realpath(directory);
}
/** Full SQLite snapshot, including visual activity and any other tables.
 * Caller must hold desktop admission closed and provide host-controlled paths.
 * This captures one database; cross-project/index consistency belongs to the update transaction.
 */
export async function createDesktopDatabaseBackup(config: HarnessConfig, backupRoot: string): Promise<DesktopDatabaseBackup> {
 let directory: string | undefined;
 try {
  await validateStateDirectory(config.workspace, config.stateDirectory);
  const sourceDirectory = await privateDirectory(config.stateDirectory);
  const source = path.join(sourceDirectory, HARNESS_SQLITE_FILE);
  const sourceStat = await statRegularFileNoFollow(source, {label: "desktop database", requireSingleLink: true});
  if (sourceStat.uid !== process.getuid?.() || (sourceStat.mode & 0o077) || sourceStat.size > DESKTOP_DATABASE_BACKUP_LIMIT) throw new Error();
  await mkdir(backupRoot, {recursive: true, mode: 0o700});
  directory = await mkdtemp(path.join(await privateDirectory(backupRoot), "database-"));
  const destination = path.join(directory, HARNESS_SQLITE_FILE);
  // SQLite creates the file inside this newly allocated private directory.
  const sourceDb = new SqliteDatabase(source, {readonly: true});
  try {
   sourceDb.exec("PRAGMA busy_timeout=1000");
   const before = sourceDb.query<{data_version: number}>("PRAGMA data_version").get()!.data_version;
   if (sourceDb.query<{page_count: number}>("PRAGMA page_count").get()!.page_count * sourceDb.query<{page_size: number}>("PRAGMA page_size").get()!.page_size > DESKTOP_DATABASE_BACKUP_LIMIT) throw new Error();
   assertIdle(sourceDb);
   // Parameter binding prevents a path from becoming SQL. INTO includes committed WAL content.
   sourceDb.query<Record<string, never>, [string]>("VACUUM INTO ?").run(destination);
   if (sourceDb.query<{data_version: number}>("PRAGMA data_version").get()!.data_version !== before) throw new Error();
  } finally {sourceDb.close();}
  await chmod(destination, 0o600);
  const snapshot = new SqliteDatabase(destination, {readonly: true});
  try {
   if (snapshot.query<{quick_check: string}>("PRAGMA quick_check").all().some(row => row.quick_check !== "ok")) throw new Error();
   assertIdle(snapshot);
  } finally {snapshot.close();}
  // Reuse core binding/schema/terminal-journal validation on the COPY, never migrate the source.
  const logical = await createHarnessStateBackup({...config, stateDirectory: directory, storeBackend: "sqlite"});
  // Core validators open/close SQLite; checkpoint any sidecars before hashing the final copy.
  const finalDb = new SqliteDatabase(destination);
  try {
   const checkpoint = finalDb.query<{busy: number}>("PRAGMA wal_checkpoint(TRUNCATE)").get();
   if (checkpoint && checkpoint.busy !== 0) throw new Error();
  } finally {finalDb.close();}
  const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); try {await file.sync();} finally {await file.close();}
  const contents = await readRegularFileNoFollow(destination, {label: "desktop backup", maxBytes: DESKTOP_DATABASE_BACKUP_LIMIT, requireSingleLink: true});
  const result = {directory, size: contents.contents.length, sha256: createHash("sha256").update(contents.contents).digest("hex"), logicalChecksum: logical.checksum};
  const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try {await parent.sync();} finally {await parent.close();}
  const rootHandle = await open(path.dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW); try {await rootHandle.sync();} finally {await rootHandle.close();}
  return result;
 } catch {
  if (directory) try {await rm(directory, {recursive: true, force: true});} catch {throw new Error("DESKTOP_BACKUP_CLEANUP_FAILED");}
  throw new Error("DESKTOP_BACKUP_FAILED");
 }
}

/** Rechecks the immutable copy against the host-held receipt before recovery may consume it. */
export async function verifyDesktopDatabaseBackup(backup: DesktopDatabaseBackup): Promise<void> {
 try {
  await privateDirectory(backup.directory);
  const contents = await readRegularFileNoFollow(path.join(backup.directory, HARNESS_SQLITE_FILE), {label: "desktop backup", maxBytes: DESKTOP_DATABASE_BACKUP_LIMIT, requireSingleLink: true});
  if (contents.stat.uid !== process.getuid?.() || (contents.stat.mode & 0o077) || contents.contents.length !== backup.size || createHash("sha256").update(contents.contents).digest("hex") !== backup.sha256) throw new Error();
 } catch {throw new Error("DESKTOP_BACKUP_INVALID");}
}
