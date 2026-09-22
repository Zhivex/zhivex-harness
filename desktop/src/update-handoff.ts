import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {link, open, unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {readRegularFileNoFollow} from "../../src/internal/desktop/persistence.js";
import {inspectDesktopUpdateJob, type DesktopUpdateJob} from "./update-job.js";
import {adoptExclusiveSqliteAccess, exclusiveSqliteAccessDescriptor, type SqliteAccessLease} from "../../src/internal/desktop/persistence.js";

const pid = z.number().int().min(1).max(2147483647), uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const stateEntry = z.object({databasePath: z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p), descriptor: z.number().int().min(4).max(603)}).strict();
const requestSchema = z.object({schemaVersion: z.literal(1), nonce: uuid, jobId: uuid, digest: hash, owners: z.array(pid).min(1).max(601), stateAccess: z.array(stateEntry).max(600)}).strict();
const ackSchema = z.object({schemaVersion: z.literal(1), nonce: uuid, jobId: uuid, digest: hash, requestSha256: hash, workerPid: pid}).strict();
const LIMIT = 3 * 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export interface DesktopUpdateHandoff {job: DesktopUpdateJob; nonce: string; sha256: string}
export interface DesktopHandoffStateAccess {readonly entries: ReadonlyArray<{readonly databasePath: string; readonly lease: SqliteAccessLease}>; close(): void}
const adopted = new WeakMap<DesktopHandoffStateAccess, string>();
async function files(handoff: Pick<DesktopUpdateHandoff, "job" | "nonce">) {
 uuid.parse(handoff.nonce);
 const job = await inspectDesktopUpdateJob(handoff.job);
 const directory = path.join(handoff.job.userData, "update-jobs", handoff.job.id);
 const base = path.join(directory, `handoff-${handoff.nonce}`);
 return {job, directory, request: base + ".json", ack: base + ".ack.json"};
}
async function publish(filename: string, contents: unknown) {
 const bytes = JSON.stringify(contents); if (Buffer.byteLength(bytes) > LIMIT) throw new Error();
 const temporary = filename + `.${randomUUID()}.tmp`;
 const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  await link(temporary, filename); await unlink(temporary);
  const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {await directory.sync();} finally {await directory.close();}
 } finally {await unlink(temporary).catch(e => {if (e.code !== "ENOENT") throw e;});}
}
async function readBytes(filename: string) {
 const file = await readRegularFileNoFollow(filename, {label: "update handoff", maxBytes: LIMIT});
 // A power failure can leave the temporary hard link from atomic publication.
 if (file.stat.uid !== process.getuid?.() || (file.stat.mode & 0o077)) throw new Error();
 return file.contents;
}
async function read(filename: string) {return JSON.parse((await readBytes(filename)).toString("utf8"));}
async function request(handoff: DesktopUpdateHandoff) {
 hash.parse(handoff.sha256);
 const location = await files(handoff), bytes = await readBytes(location.request);
 if (sha(bytes) !== handoff.sha256) throw new Error();
 const value = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
 if (value.nonce !== handoff.nonce || value.jobId !== handoff.job.id || value.digest !== location.job.digest || new Set(value.owners).size !== value.owners.length) throw new Error();
 if (value.stateAccess.some((entry, i) => entry.descriptor !== i + 4) ||
     JSON.stringify(value.stateAccess.map(entry => entry.databasePath).sort()) !== JSON.stringify(location.job.databasePaths)) throw new Error();
 return {...location, value};
}
function alive(value: number): boolean {
 try {process.kill(value, 0); return true;} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  // EPERM and all unknown process states fail closed; never interpret them as exit.
  throw new Error("UPDATE_OWNER_STATUS_UNKNOWN");
 }
}
function timeout(value: number | undefined, fallback: number) {
 const ms = value ?? fallback;
 if (!Number.isInteger(ms) || ms < 1 || ms > 120000) throw new Error();
 return performance.now() + ms;
}
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 25));

/** Called while admission is closed. Includes main automatically; caller adds
 * every known runtime PID. This is not enumeration of arbitrary external owners.
 */
export async function prepareDesktopUpdateHandoff(job: DesktopUpdateJob, ownerPids: number[], stateAccess: Array<{databasePath: string; lease: SqliteAccessLease}> = []): Promise<DesktopUpdateHandoff> {
 try {
  stateAccess = stateAccess.map(entry => ({...entry}));
  const handoff = {job: structuredClone(job), nonce: randomUUID()}, location = await files(handoff);
  if (location.job.phase === "completed") throw new Error();
  if (JSON.stringify(stateAccess.map(entry => entry.databasePath).sort()) !== JSON.stringify(location.job.databasePaths)) throw new Error();
  const descriptors = stateAccess.map(entry => exclusiveSqliteAccessDescriptor(entry.lease, entry.databasePath));
  if (new Set(descriptors).size !== descriptors.length) throw new Error();
  const value = requestSchema.parse({schemaVersion: 1, nonce: handoff.nonce, jobId: job.id, digest: location.job.digest, owners: [...new Set([process.pid, ...ownerPids])], stateAccess: stateAccess.map((entry, i) => ({databasePath: entry.databasePath, descriptor: i + 4}))});
  await publish(location.request, value); return {...handoff, sha256: sha(JSON.stringify(value))};
 } catch {throw new Error("UPDATE_HANDOFF_PREPARE_FAILED");}
}

/** Worker only, with the native worker lock held and fd 3 retained. Publication
 * proves this process loaded the pinned job. It grants no installation authority
 * until all recorded owners exit and the separate state-owner guard succeeds.
 */
export async function acknowledgeDesktopUpdateHandoff(handoff: DesktopUpdateHandoff, access?: DesktopHandoffStateAccess): Promise<void> {
 try {
  const location = await request(handoff);
  if (location.value.owners.includes(process.pid)) throw new Error();
  validateAccess(handoff, location.value.stateAccess, access);
  await publish(location.ack, {schemaVersion: 1, nonce: handoff.nonce, jobId: handoff.job.id, digest: location.value.digest, requestSha256: handoff.sha256, workerPid: process.pid});
 } catch {throw new Error("UPDATE_HANDOFF_ACK_FAILED");}
}

export async function waitForDesktopUpdateAcknowledgement(handoff: DesktopUpdateHandoff, workerPid: number, options: {timeoutMs?: number} = {}): Promise<void> {
 try {
  pid.parse(workerPid); const until = timeout(options.timeoutMs, 10000), location = await request(handoff);
  while (performance.now() < until) {
   if (!alive(workerPid)) throw new Error();
   let contents: unknown;
   try {contents = await read(location.ack);} catch (e) {if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await delay(); continue;}
   const ack = ackSchema.parse(contents);
   if (ack.nonce !== handoff.nonce || ack.jobId !== handoff.job.id || ack.digest !== location.value.digest || ack.requestSha256 !== handoff.sha256 || ack.workerPid !== workerPid || !alive(workerPid)) throw new Error();
   return;
  }
  throw new Error();
 } catch {throw new Error("UPDATE_HANDOFF_UNCONFIRMED");}
}

/** Known PIDs only. PID reuse conservatively blocks. Never sends termination or
 * cancellation signals. Call again at each destructive boundary via assertStopped.
 */
export async function assertDesktopUpdateOwnersStopped(handoff: DesktopUpdateHandoff, access?: DesktopHandoffStateAccess): Promise<void> {
 try {const location = await request(handoff); validateAccess(handoff, location.value.stateAccess, access); if (location.value.owners.some(alive)) throw new Error();}
 catch {throw new Error("UPDATE_OWNERS_NOT_STOPPED");}
}

export async function waitForDesktopUpdateOwners(handoff: DesktopUpdateHandoff, options: {timeoutMs?: number; stateAccess?: DesktopHandoffStateAccess} = {}): Promise<void> {
 try {
  const until = timeout(options.timeoutMs, 60000), location = await request(handoff);
  if (location.value.owners.includes(process.pid)) throw new Error();
  while (performance.now() < until) {validateAccess(handoff, location.value.stateAccess, options.stateAccess); if (!location.value.owners.some(alive)) return; await delay();}
  throw new Error();
 } catch {throw new Error("UPDATE_OWNERS_NOT_STOPPED");}
}

function validateAccess(handoff: DesktopUpdateHandoff, entries: z.infer<typeof stateEntry>[], access?: DesktopHandoffStateAccess) {
 if (entries.length === 0 && !access) return;
 if (!access || adopted.get(access) !== handoff.sha256 || access.entries.length !== entries.length) throw new Error();
 for (const [i, entry] of entries.entries()) {
  const actual = access.entries[i]!;
  if (actual.databasePath !== entry.databasePath || exclusiveSqliteAccessDescriptor(actual.lease, entry.databasePath) !== entry.descriptor) throw new Error();
 }
}

/** Worker bootstrap, before acknowledgement. Native helper validates LOCK_EX;
 * this verifies the complete descriptor/path inventory against the backup receipt.
 */
export async function adoptDesktopUpdateHandoffState(handoff: DesktopUpdateHandoff): Promise<DesktopHandoffStateAccess> {
 const entries: Array<{databasePath: string; lease: SqliteAccessLease}> = [];
 const close = () => {let failed = false; for (const entry of entries) {try {entry.lease.close();} catch {failed = true;}} if (failed) throw new Error("UPDATE_HANDOFF_ACCESS_CLOSE_FAILED");};
 try {
  const location = await request(handoff);
  if (location.value.owners.includes(process.pid)) throw new Error();
  for (const entry of location.value.stateAccess) entries.push(Object.freeze({databasePath: entry.databasePath, lease: adoptExclusiveSqliteAccess(entry.databasePath, entry.descriptor)}));
  const access = Object.freeze({entries: Object.freeze(entries), close}); adopted.set(access, handoff.sha256); return access;
 } catch {close(); throw new Error("UPDATE_HANDOFF_ACCESS_INVALID");}
}
