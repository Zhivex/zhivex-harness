import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, open, realpath, rename, unlink, link, rm} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {validateRecordedWorkspace} from "../../src/recorded-workspace.js";
import {readRegularFileNoFollow, statRegularFileNoFollow} from "../../src/file-security.js";
import {validateStateDirectory} from "../../src/state-directory.js";
import {HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {createDesktopDatabaseBackup, verifyDesktopDatabaseBackup, verifyDesktopDatabaseState, DESKTOP_DATABASE_BACKUP_LIMIT, type DesktopBackupConfig} from "./database-backup.js";
import {createDesktopMetadataBackup, readDesktopMetadataBackup, verifyDesktopMetadataState} from "./metadata-backup.js";
import {resolveHarnessConfig} from "../../src/config.js";
import {exclusiveSqliteAccessDescriptor, type SqliteAccessLease} from "../../src/sqlite-access.js";
import {checkDesktopStateFormat, DESKTOP_STATE_FORMAT} from "./state-format.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p);
const scopePart = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/);
const scope = z.object({tenantId: scopePart, userId: scopePart.optional(), namespace: scopePart.optional()}).strict();
const file = z.union([z.object({name: z.string().max(512), size: z.number().int().min(0).max(1024 * 1024), sha256: hash}).strict(), z.object({name: z.string().max(512), absent: z.literal(true)}).strict()]);
const receiptSchema = z.object({schemaVersion: z.literal(1), userData: absolute, format: z.literal(1),
 databases: z.array(z.object({workspace: absolute, workspaceAbsent: z.literal(true).optional(), scope: scope.optional(), stateDirectory: absolute, backup: z.object({directory: z.string().regex(/^database-[A-Za-z0-9]+$/), size: z.number().int().min(1).max(DESKTOP_DATABASE_BACKUP_LIMIT), sha256: hash, logicalChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict().nullable()}).strict()).max(600),
 metadata: z.object({directory: z.string().regex(/^metadata-[A-Za-z0-9]+$/), files: z.array(file).max(4096)}).strict(),
}).strict();
const pointerSchema = z.object({schemaVersion: z.literal(1), id: z.string().uuid(), sha256: hash}).strict();
export interface DesktopStateTransaction {id: string; sha256: string}
const ROOT = "update-recovery", MARKER = "state-compatibility/format.json", RECEIPT_LIMIT = 2 * 1024 * 1024, TOTAL_LIMIT = 512 * 1024 * 1024;
async function exists(filename: string) {try {await lstat(filename); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e;}}
async function privateDir(directory: string) {
 await mkdir(directory, {recursive: true, mode: 0o700});
 const s = await lstat(directory); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error();
}
async function sync(directory: string) {const h = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try {await h.sync();} finally {await h.close();}}
async function read(filename: string, limit: number) {
 // Atomic publication may leave its private temporary hard link after a crash.
 const f = await readRegularFileNoFollow(filename, {label: "update recovery", maxBytes: limit});
 if (f.stat.uid !== process.getuid?.() || (f.stat.mode & 0o077)) throw new Error(); return f.contents;
}
async function publish(filename: string, bytes: Buffer | string, replace: boolean) {
 await privateDir(path.dirname(filename));
 const temporary = path.join(path.dirname(filename), `.update-${randomUUID()}`);
 const h = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {
  try {await h.writeFile(bytes); await h.sync();} finally {await h.close();}
  if (replace) await rename(temporary, filename); else {await link(temporary, filename); await unlink(temporary);}
  await sync(path.dirname(filename));
 } finally {await unlink(temporary).catch(e => {if (e.code !== "ENOENT") throw e;});}
}
async function context(userData: string) {
 const home = await realpath(userData), root = path.join(home, ROOT);
 await privateDir(root); await sync(home);
 return {home, root, active: path.join(root, "active.json")};
}
async function load(userData: string, transaction: DesktopStateTransaction) {
 const ctx = await context(userData), pointer = pointerSchema.parse({schemaVersion: 1, ...transaction});
 const directory = path.join(ctx.root, pointer.id);
 const bytes = await read(path.join(directory, "receipt.json"), RECEIPT_LIMIT);
 if (sha(bytes) !== pointer.sha256) throw new Error();
 const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")));
 if (receipt.userData !== ctx.home || new Set(receipt.databases.map(d => d.stateDirectory)).size !== receipt.databases.length || receipt.databases.reduce((n, d) => n + (d.backup?.size ?? 0), 0) > TOTAL_LIMIT) throw new Error();
 for (const db of receipt.databases) {
  await validateRecordedWorkspace(db.workspace, db.workspaceAbsent === true);
  if (await exists(db.stateDirectory) && await realpath(db.stateDirectory) !== db.stateDirectory) throw new Error();
  await validateStateDirectory(db.workspace, db.stateDirectory);
 }
 return {...ctx, directory, receipt};
}

/** Read-only binding check for the durable update job. Absence is meaningful only
 * after that job has persisted its finishing phase; it is not proof of success.
 */
export async function desktopStateTransactionStatus(userData: string, transaction: DesktopStateTransaction): Promise<"active" | "absent"> {
 try {
  const ctx = await load(userData, transaction);
  if (!await exists(ctx.active)) {
   const marker = JSON.parse((await read(path.join(ctx.home, MARKER), 1024)).toString("utf8"));
   if (marker?.format !== DESKTOP_STATE_FORMAT || marker?.phase !== "ready" || Object.keys(marker).length !== 2) throw new Error();
   return "absent";
  }
  const pointer = pointerSchema.parse(JSON.parse((await read(ctx.active, 1024)).toString("utf8")));
  if (pointer.id !== transaction.id || pointer.sha256 !== transaction.sha256) throw new Error();
  return "active";
 } catch {throw new Error("DESKTOP_STATE_TRANSACTION_MISMATCH");}
}

/** Startup recovery reads the pinned receipt before any project registry opens. */
export async function activeDesktopStateTransaction(userData: string): Promise<DesktopStateTransaction> {
 const ctx = await context(userData);
 const pointer = pointerSchema.parse(JSON.parse((await read(ctx.active, 1024)).toString("utf8")));
 const transaction = {id: pointer.id, sha256: pointer.sha256};
 await load(userData, transaction);
 return transaction;
}

/** Host/worker-only inventory bound to the persisted receipt hash. */
export async function desktopStateTransactionDatabasePaths(userData: string, transaction: DesktopStateTransaction): Promise<string[]> {
 try {const ctx = await load(userData, transaction); return ctx.receipt.databases.map(db => path.join(db.stateDirectory, HARNESS_SQLITE_FILE)).sort();}
 catch {throw new Error("DESKTOP_STATE_TRANSACTION_MISMATCH");}
}

/** Confirmation while the recovery gate is still active. This validates format-1
 * state under every exclusive lease; it must not compare old metadata after the
 * gate has cleared and a restarted application may have accepted new work.
 */
export async function verifyDesktopStateTransaction(userData: string, transaction: DesktopStateTransaction, supplied: ReadonlyArray<{databasePath: string; lease: SqliteAccessLease}>): Promise<void> {
 try {
  const access = supplied.map(entry => ({...entry})), ctx = await load(userData, transaction);
  const expected = ctx.receipt.databases.map(db => path.join(db.stateDirectory, HARNESS_SQLITE_FILE)).sort();
  if (JSON.stringify(access.map(entry => entry.databasePath).sort()) !== JSON.stringify(expected)) throw new Error();
  const leases = new Map(access.map(entry => [entry.databasePath, entry.lease]));
  const guard = async () => {
   if (await desktopStateTransactionStatus(userData, transaction) !== "active") throw new Error();
   for (const entry of access) exclusiveSqliteAccessDescriptor(entry.lease, entry.databasePath);
  };
  await guard();
  const marker = JSON.parse((await read(path.join(ctx.home, MARKER), 1024)).toString("utf8"));
  if (marker?.format !== DESKTOP_STATE_FORMAT || !["migrating", "ready"].includes(marker?.phase) || Object.keys(marker).length !== 2) throw new Error();
  for (const db of ctx.receipt.databases) {
   const databasePath = path.join(db.stateDirectory, HARNESS_SQLITE_FILE);
   if (!db.backup) {
    for (const suffix of ["", "-wal", "-shm"]) if (await exists(databasePath + suffix)) throw new Error();
   } else {
    // Older receipts remain restorable, but lack an explicit scope for this new
    // verification path. Never infer it from the worker environment.
    if (!db.scope) throw new Error();
    const config = {...resolveHarnessConfig({workspace: db.workspace, stateDirectory: db.stateDirectory, storeBackend: "sqlite", provider: "openai"}), scope: {tenantId: db.scope.tenantId, ...(db.scope.userId ? {userId: db.scope.userId} : {}), ...(db.scope.namespace ? {namespace: db.scope.namespace} : {})}};
    await verifyDesktopDatabaseState({...config, ...(db.workspaceAbsent ? {workspaceAbsent: true as const} : {}), accessLease: leases.get(databasePath)!});
   }
   await guard();
  }
  await verifyDesktopMetadataState(ctx.home, {...ctx.receipt.metadata, directory: path.join(ctx.directory, ctx.receipt.metadata.directory)});
  await guard();
 } catch {throw new Error("DESKTOP_STATE_VERIFICATION_FAILED");}
}

/** Caller enumerates all registered projects/tasks and holds admission closed for the entire transaction. */
export async function prepareDesktopStateTransaction(userData: string, configs: DesktopBackupConfig[]): Promise<DesktopStateTransaction> {
 let ownedDirectory: string | undefined;
 try {
  await checkDesktopStateFormat(userData);
  const ctx = await context(userData); if (await exists(ctx.active)) throw new Error();
  if (configs.length > 600) throw new Error();
  const id = randomUUID(), directory = path.join(ctx.root, id); await mkdir(directory, {mode: 0o700}); ownedDirectory = directory; await sync(ctx.root);
  const databases: z.infer<typeof receiptSchema>["databases"] = []; let total = 0;
  for (const config of configs) {
   if (config.storeBackend !== "sqlite") throw new Error();
   await validateStateDirectory(config.workspace, config.stateDirectory);
   const workspace = await validateRecordedWorkspace(config.workspace, config.workspaceAbsent === true);
   const stateDirectory = await exists(config.stateDirectory) ? await realpath(config.stateDirectory) : path.resolve(config.stateDirectory);
   if (databases.some(d => d.stateDirectory === stateDirectory)) continue;
   let backup = null;
   if (await exists(path.join(stateDirectory, HARNESS_SQLITE_FILE))) {
    const copy = await createDesktopDatabaseBackup({...config, workspace, stateDirectory}, directory);
    total += copy.size; if (total > TOTAL_LIMIT) throw new Error();
    backup = {...copy, directory: path.basename(copy.directory)};
   }
   databases.push({workspace, stateDirectory, scope: config.scope, backup, ...(config.workspaceAbsent ? {workspaceAbsent: true as const} : {})});
  }
  const metadataCopy = await createDesktopMetadataBackup(ctx.home, directory);
  const metadata = {...metadataCopy, directory: path.basename(metadataCopy.directory)};
  const receipt = receiptSchema.parse({schemaVersion: 1, userData: ctx.home, format: DESKTOP_STATE_FORMAT, databases, metadata});
  const bytes = JSON.stringify(receipt); if (Buffer.byteLength(bytes) > RECEIPT_LIMIT) throw new Error();
  await publish(path.join(directory, "receipt.json"), bytes, false);
  return {id, sha256: sha(bytes)};
 } catch {
  if (ownedDirectory) try {await rm(ownedDirectory, {recursive: true, force: true});} catch {throw new Error("DESKTOP_STATE_BACKUP_CLEANUP_FAILED");}
  throw new Error("DESKTOP_STATE_BACKUP_FAILED");
 }
}

/** Persist recovery intent BEFORE any installation/migration mutates state. */
export async function armDesktopStateTransaction(userData: string, transaction: DesktopStateTransaction): Promise<void> {
 try {
  const ctx = await load(userData, transaction); await checkDesktopStateFormat(userData);
  await publish(ctx.active, JSON.stringify({schemaVersion: 1, ...transaction}), false);
  await publish(path.join(ctx.home, MARKER), JSON.stringify({format: DESKTOP_STATE_FORMAT, phase: "migrating"}), true);
 } catch {throw new Error("DESKTOP_STATE_ARM_FAILED");}
}

/** Call only after every runtime/external state owner is confirmed stopped.
 * Restoring is retryable: originals and overwritten partial restorations are quarantined, never deleted.
 * This restores application STATE only. App-binary rollback must finish before the journal is cleared.
 */
export async function restoreDesktopStateTransaction(userData: string, options: {
 assertStopped(): Promise<void>;
 afterWrite?: (index: number) => Promise<void>; // Deterministic fixture failure injection, host only.
}): Promise<void> {
 try {
  const base = await context(userData), pointer = pointerSchema.parse(JSON.parse((await read(base.active, 1024)).toString("utf8")));
  const ctx = await load(userData, {id: pointer.id, sha256: pointer.sha256});
  // Verify all sources before allowing the first destination write.
  for (const db of ctx.receipt.databases) if (db.backup) await verifyDesktopDatabaseBackup({...db.backup, directory: path.join(ctx.directory, db.backup.directory)});
  const values = await readDesktopMetadataBackup({...ctx.receipt.metadata, directory: path.join(ctx.directory, ctx.receipt.metadata.directory)});
  if (values.get(MARKER)?.toString() !== JSON.stringify({format: DESKTOP_STATE_FORMAT, phase: "ready"})) {
   const marker = JSON.parse(values.get(MARKER)?.toString() ?? "null");
   if (marker?.format !== DESKTOP_STATE_FORMAT || marker?.phase !== "ready" || Object.keys(marker).length !== 2) throw new Error();
  }
  await options.assertStopped();
  // Preserve current metadata too, including files introduced by an interrupted migration.
  const current = await createDesktopMetadataBackup(ctx.home, path.join(ctx.directory, "before-restore"));
  const quarantine = path.join(ctx.directory, "quarantine"); await privateDir(quarantine);
  let writes = 0;
  async function preserve(filename: string, target: string) {
   if (!await exists(filename)) return;
   const s = await statRegularFileNoFollow(filename, {label: "state recovery target", requireSingleLink: true});
   if (s.uid !== process.getuid?.()) throw new Error();
   await rename(filename, path.join(target, randomUUID())); await sync(target); await sync(path.dirname(filename));
  }
  for (const db of ctx.receipt.databases) {
   await options.assertStopped();
   let bytes: Buffer | undefined;
   if (db.backup) {
    bytes = await read(path.join(ctx.directory, db.backup.directory, HARNESS_SQLITE_FILE), DESKTOP_DATABASE_BACKUP_LIMIT);
    if (bytes.length !== db.backup.size || sha(bytes) !== db.backup.sha256) throw new Error();
   }
   if (!bytes && !await exists(db.stateDirectory)) continue;
   await privateDir(db.stateDirectory);
   const saved = path.join(db.stateDirectory, `.update-recovery-${pointer.id}`); await privateDir(saved);
   // Quarantine WAL/SHM alongside the old DB, so stale pages cannot attach to the restored copy.
   for (const suffix of ["-wal", "-shm", ""]) await preserve(path.join(db.stateDirectory, HARNESS_SQLITE_FILE + suffix), saved);
   if (bytes) await publish(path.join(db.stateDirectory, HARNESS_SQLITE_FILE), bytes, false);
   await options.afterWrite?.(++writes);
  }
  const names = new Set([...values.keys(), ...current.files.map(f => f.name)]);
  for (const name of names) {
   if (name === MARKER) continue; // Keep the migration barrier until the entire update is recovered.
   await options.assertStopped();
   const target = path.join(ctx.home, name); await preserve(target, quarantine);
   const bytes = values.get(name); if (bytes) await publish(target, bytes, false);
   await options.afterWrite?.(++writes);
  }
  // active.json and migrating marker deliberately remain until binary rollback is confirmed.
 } catch {throw new Error("DESKTOP_STATE_RESTORE_FAILED");}
}

/** Completes either successful installation or fully verified state+binary recovery. */
export async function finishDesktopStateTransaction(userData: string, confirm: () => Promise<void>): Promise<void> {
 try {
  const ctx = await context(userData);
  const pointer = pointerSchema.parse(JSON.parse((await read(ctx.active, 1024)).toString("utf8")));
  await load(userData, {id: pointer.id, sha256: pointer.sha256});
  await confirm();
  await publish(path.join(ctx.home, MARKER), JSON.stringify({format: DESKTOP_STATE_FORMAT, phase: "ready"}), true);
  await unlink(ctx.active); await sync(ctx.root);
 } catch {throw new Error("DESKTOP_STATE_FINISH_FAILED");}
}
