import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, open, realpath, rename, unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {readRegularFileNoFollow} from "../../src/file-security.js";
import {createApplicationSwapper, type ApplicationSwap} from "./application-swap.js";
import {desktopStateTransactionStatus, desktopStateTransactionDatabasePaths, finishDesktopStateTransaction, restoreDesktopStateTransaction, type DesktopStateTransaction} from "./state-transaction.js";

const absolute = z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p));
const schema = z.object({schemaVersion: z.literal(1), id: z.string().uuid(), userData: absolute,
 state: z.object({id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 application: z.object({id: z.string().uuid(), application: absolute}).strict(),
 phase: z.enum(["prepared", "applying", "recovering", "finishing", "completed"]),
 outcome: z.enum(["installed", "restored"]).nullable(),
}).strict().refine(j => (["finishing", "completed"].includes(j.phase)) === (j.outcome !== null));
type Journal = z.infer<typeof schema>;
export type DesktopUpdateOutcome = "installed" | "restored";
export interface DesktopUpdateJob {userData: string; id: string}
async function privateDirectory(directory: string) {
 const info = await lstat(directory);
 if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error();
}
async function sync(directory: string) {const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try {await file.sync();} finally {await file.close();}}
async function location(job: DesktopUpdateJob) {
 z.string().uuid().parse(job.id); absolute.parse(job.userData);
 if (await realpath(job.userData) !== job.userData) throw new Error();
 const root = path.join(job.userData, "update-jobs"), directory = path.join(root, job.id);
 await privateDirectory(root); await privateDirectory(directory);
 return directory;
}
async function save(directory: string, journal: Journal) {
 const temporary = path.join(directory, `.job-${randomUUID()}`), file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {
  try {await file.writeFile(JSON.stringify(schema.parse(journal))); await file.sync();} finally {await file.close();}
  await rename(temporary, path.join(directory, "job.json")); await sync(directory);
 } finally {await unlink(temporary).catch(e => {if (e.code !== "ENOENT") throw e;});}
}
async function load(job: DesktopUpdateJob) {
 const directory = await location(job);
 const file = await readRegularFileNoFollow(path.join(directory, "job.json"), {label: "update job", maxBytes: 16 * 1024, requireSingleLink: true});
 if (file.stat.uid !== process.getuid?.() || (file.stat.mode & 0o077)) throw new Error();
 const journal = schema.parse(JSON.parse(file.contents.toString("utf8")));
 if (journal.id !== job.id || journal.userData !== job.userData) throw new Error();
 return {directory, journal};
}

/** Host/worker handoff identity and inventory. Must never be exposed through renderer IPC. */
export async function inspectDesktopUpdateJob(job: DesktopUpdateJob) {
 try {
  const {journal} = await load(job);
  if (journal.phase !== "completed") {
   const status = await desktopStateTransactionStatus(job.userData, journal.state);
   if (status !== "active" && journal.phase !== "finishing") throw new Error();
  }
  const identity = {schemaVersion: journal.schemaVersion, id: journal.id, userData: journal.userData, state: journal.state, application: journal.application};
  return {phase: journal.phase, state: structuredClone(journal.state), digest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), databasePaths: await desktopStateTransactionDatabasePaths(job.userData, journal.state)};
 } catch {throw new Error("UPDATE_JOB_INVALID");}
}

/** After state recovery is armed, before launch. The host supplies both receipts. */
export async function prepareDesktopUpdateJob(userData: string, state: DesktopStateTransaction, application: ApplicationSwap): Promise<DesktopUpdateJob> {
 try {
  userData = await realpath(userData);
  if (await desktopStateTransactionStatus(userData, state) !== "active") throw new Error();
  const root = path.join(userData, "update-jobs"); await mkdir(root, {recursive: true, mode: 0o700}); await privateDirectory(root); await sync(userData);
  const id = randomUUID(), directory = path.join(root, id); await mkdir(directory, {mode: 0o700}); await sync(root);
  await save(directory, schema.parse({schemaVersion: 1, id, userData, state, application, phase: "prepared", outcome: null}));
  return {userData, id};
 } catch {throw new Error("UPDATE_JOB_PREPARE_FAILED");}
}

/** Run only with the native worker lock held. assertStopped must prove admission
 * is closed and all state owners stopped. verifyState must inspect compatibility
 * without admitting user work. No callback comes from the renderer.
 */
export async function executeDesktopUpdateJob(job: DesktopUpdateJob, deps: {
 assertStopped(): Promise<void>;
 verifyState(outcome: DesktopUpdateOutcome): Promise<void>;
 swapper?: ReturnType<typeof createApplicationSwapper>;
 afterPersist?: (phase: Journal["phase"]) => Promise<void>; // Host fixture crash boundaries.
 afterStateFinished?: () => Promise<void>;
}): Promise<DesktopUpdateOutcome> {
 let loaded;
 try {loaded = await load(job);} catch {throw new Error("UPDATE_JOB_INVALID");}
 const {directory, journal} = loaded, swapper = deps.swapper ?? createApplicationSwapper();
 if (journal.phase === "completed") return journal.outcome!;
 const active = () => desktopStateTransactionStatus(job.userData, journal.state);
 const stopped = async () => {if (await active() !== "active") throw new Error("UPDATE_JOB_STATE_MISSING"); await deps.assertStopped();};
 const confirm = async (outcome: DesktopUpdateOutcome) => {await swapper.verifyOutcome(journal.application, outcome); await deps.verifyState(outcome);};
 async function transition(phase: Journal["phase"], outcome: DesktopUpdateOutcome | null = null) {
  journal.phase = phase; journal.outcome = outcome; await save(directory, journal); await deps.afterPersist?.(phase);
 }
 // No effects before stopped is confirmed. Once finishing is durable, missing
 // active.json can mean successful clearance followed by a lost acknowledgement.
 if (journal.phase !== "finishing") await stopped();
 if (journal.phase === "prepared") await transition("applying");
 if (journal.phase === "applying") {
  let installed = false;
  try {await swapper.activate(journal.application, {assertStopped: stopped}); await confirm("installed"); installed = true;} catch {}
  await transition(installed ? "finishing" : "recovering", installed ? "installed" : null);
 }
 if (journal.phase === "recovering") {
  try {
   await stopped(); await swapper.rollback(journal.application, {assertStopped: stopped});
   await restoreDesktopStateTransaction(job.userData, {assertStopped: stopped}); await confirm("restored");
  } catch {throw new Error("UPDATE_JOB_RECOVERY_REQUIRED");}
  await transition("finishing", "restored");
 }
 if (journal.phase === "finishing") {
  try {
   if (await active() === "active") {
    await stopped(); await finishDesktopStateTransaction(job.userData, () => confirm(journal.outcome!));
   } else {
    // Never replay rollback or overwrite state here: the app may already have
    // reopened and accepted new user work after clearance of the recovery gate.
    await confirm(journal.outcome!);
   }
  } catch {throw new Error("UPDATE_JOB_CONFIRMATION_REQUIRED");}
  await deps.afterStateFinished?.();
  await transition("completed", journal.outcome);
 }
 return journal.outcome!;
}
