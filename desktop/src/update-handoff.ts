import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {link, open, unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {readRegularFileNoFollow} from "../../src/file-security.js";
import {inspectDesktopUpdateJob, type DesktopUpdateJob} from "./update-job.js";

const pid = z.number().int().min(1).max(2147483647), uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({schemaVersion: z.literal(1), nonce: uuid, jobId: uuid, digest: hash, owners: z.array(pid).min(1).max(601)}).strict();
const ackSchema = z.object({schemaVersion: z.literal(1), nonce: uuid, jobId: uuid, digest: hash, workerPid: pid}).strict();
export interface DesktopUpdateHandoff {job: DesktopUpdateJob; nonce: string}
async function files(handoff: DesktopUpdateHandoff) {
 uuid.parse(handoff.nonce);
 const job = await inspectDesktopUpdateJob(handoff.job);
 const directory = path.join(handoff.job.userData, "update-jobs", handoff.job.id);
 const base = path.join(directory, `handoff-${handoff.nonce}`);
 return {job, directory, request: base + ".json", ack: base + ".ack.json"};
}
async function publish(filename: string, contents: unknown) {
 const temporary = filename + `.${randomUUID()}.tmp`;
 const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {
  try {await file.writeFile(JSON.stringify(contents)); await file.sync();} finally {await file.close();}
  await link(temporary, filename); await unlink(temporary);
  const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {await directory.sync();} finally {await directory.close();}
 } finally {await unlink(temporary).catch(e => {if (e.code !== "ENOENT") throw e;});}
}
async function read(filename: string) {
 const file = await readRegularFileNoFollow(filename, {label: "update handoff", maxBytes: 16 * 1024});
 // A power failure can leave the temporary hard link from atomic publication.
 if (file.stat.uid !== process.getuid?.() || (file.stat.mode & 0o077)) throw new Error();
 return JSON.parse(file.contents.toString("utf8"));
}
async function request(handoff: DesktopUpdateHandoff) {
 const location = await files(handoff), value = requestSchema.parse(await read(location.request));
 if (value.nonce !== handoff.nonce || value.jobId !== handoff.job.id || value.digest !== location.job.digest || new Set(value.owners).size !== value.owners.length) throw new Error();
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
export async function prepareDesktopUpdateHandoff(job: DesktopUpdateJob, ownerPids: number[]): Promise<DesktopUpdateHandoff> {
 try {
  const handoff = {job: structuredClone(job), nonce: randomUUID()}, location = await files(handoff);
  if (location.job.phase === "completed") throw new Error();
  const value = requestSchema.parse({schemaVersion: 1, nonce: handoff.nonce, jobId: job.id, digest: location.job.digest, owners: [...new Set([process.pid, ...ownerPids])]});
  await publish(location.request, value); return handoff;
 } catch {throw new Error("UPDATE_HANDOFF_PREPARE_FAILED");}
}

/** Worker only, with the native worker lock held and fd 3 retained. Publication
 * proves this process loaded the pinned job. It grants no installation authority
 * until all recorded owners exit and the separate state-owner guard succeeds.
 */
export async function acknowledgeDesktopUpdateHandoff(handoff: DesktopUpdateHandoff): Promise<void> {
 try {
  const location = await request(handoff);
  if (location.value.owners.includes(process.pid)) throw new Error();
  await publish(location.ack, {schemaVersion: 1, nonce: handoff.nonce, jobId: handoff.job.id, digest: location.value.digest, workerPid: process.pid});
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
   if (ack.nonce !== handoff.nonce || ack.jobId !== handoff.job.id || ack.digest !== location.value.digest || ack.workerPid !== workerPid || !alive(workerPid)) throw new Error();
   return;
  }
  throw new Error();
 } catch {throw new Error("UPDATE_HANDOFF_UNCONFIRMED");}
}

/** Known PIDs only. PID reuse conservatively blocks. Never sends termination or
 * cancellation signals. Call again at each destructive boundary via assertStopped.
 */
export async function assertDesktopUpdateOwnersStopped(handoff: DesktopUpdateHandoff): Promise<void> {
 try {const location = await request(handoff); if (location.value.owners.some(alive)) throw new Error();}
 catch {throw new Error("UPDATE_OWNERS_NOT_STOPPED");}
}

export async function waitForDesktopUpdateOwners(handoff: DesktopUpdateHandoff, options: {timeoutMs?: number} = {}): Promise<void> {
 try {
  const until = timeout(options.timeoutMs, 60000), location = await request(handoff);
  if (location.value.owners.includes(process.pid)) throw new Error();
  while (performance.now() < until) {if (!location.value.owners.some(alive)) return; await delay();}
  throw new Error();
 } catch {throw new Error("UPDATE_OWNERS_NOT_STOPPED");}
}
