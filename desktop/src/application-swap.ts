import {randomUUID} from "node:crypto";
import {constants, type Stats} from "node:fs";
import {cp, lstat, mkdir, open, realpath, rename, unlink, rm, readdir} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {readRegularFileNoFollow} from "../../src/internal/desktop/persistence.js";
import {createMacApplicationVerifier} from "./mac-application-verifier.js";
import {compareUpdateVersions} from "./update-manifest.js";

const schema = z.object({schemaVersion: z.literal(1), application: z.string().max(4096), teamId: z.string().regex(/^[A-Z0-9]{10}$/), previousVersion: z.string().max(128), nextVersion: z.string().max(128), phase: z.enum(["prepared", "swapping", "installed", "rolling-back", "restored"])}).strict();
type Journal = z.infer<typeof schema>;
type Verify = (application: string, policy: {teamId: string; version: string}) => Promise<unknown>;
export interface ApplicationSwap {application: string; id: string}
async function exists(filename: string) {try {await lstat(filename); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e;}}
async function sync(filename: string, expected?: Stats) {
 const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const actual = await file.stat();
  if (expected && (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)) throw new Error("UPDATE_APPLICATION_FILE_CHANGED");
  if (!expected && !actual.isDirectory()) throw new Error("UPDATE_APPLICATION_DIRECTORY_CHANGED");
  await file.sync();
 } finally {await file.close();}
}
async function save(directory: string, journal: Journal) {
 const temporary = path.join(directory, `.journal-${randomUUID()}`), file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {
  try {await file.writeFile(JSON.stringify(journal)); await file.sync();} finally {await file.close();}
  await rename(temporary, path.join(directory, "journal.json")); await sync(directory);
 } finally {await unlink(temporary).catch(e => {if (e.code !== "ENOENT") throw e;});}
}
async function location(swap: ApplicationSwap) {
 z.string().uuid().parse(swap.id);
 if (!path.isAbsolute(swap.application) || !swap.application.endsWith(".app") || /[\x00-\x1f\x7f]/.test(swap.application)) throw new Error();
 const parent = await realpath(path.dirname(swap.application));
 if (path.join(parent, path.basename(swap.application)) !== swap.application) throw new Error();
 const directory = path.join(parent, `.zhivex-update-${swap.id}`), info = await lstat(directory);
 if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error();
 return {parent, directory, previous: path.join(directory, "previous.app"), next: path.join(directory, "next.app")};
}
async function load(swap: ApplicationSwap) {
 const loc = await location(swap);
 const file = await readRegularFileNoFollow(path.join(loc.directory, "journal.json"), {label: "application swap", maxBytes: 16 * 1024, requireSingleLink: true});
 if (file.stat.uid !== process.getuid?.() || (file.stat.mode & 0o077)) throw new Error();
 const journal = schema.parse(JSON.parse(file.contents.toString("utf8")));
 if (journal.application !== swap.application || compareUpdateVersions(journal.nextVersion, journal.previousVersion) <= 0) throw new Error();
 return {...loc, journal};
}
async function realBundle(application: string) {
 const info = await lstat(application); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
 return realpath(application);
}
async function checkTree(application: string, flush: boolean) {
 let entries = 0, bytes = 0;
 const visit = async (filename: string, depth: number): Promise<void> => {
  if (++entries > 50_000 || depth > 32) throw new Error();
  const info = await lstat(filename);
  if (info.isSymbolicLink()) {
   const target = await realpath(filename); if (target !== application && !target.startsWith(application + path.sep)) throw new Error();
  } else if (info.isDirectory()) {
   for (const name of await readdir(filename)) await visit(path.join(filename, name), depth + 1);
   if (flush) await sync(filename);
  } else if (info.isFile()) {
   bytes += info.size; if (bytes > 2 * 1024 ** 3) throw new Error();
   if (flush) await sync(filename, info);
  } else throw new Error();
 };
 await visit(application, 0);
}

/** Host-only filesystem transaction. The caller must pin the signed manifest's version/team,
 * stage an immutable candidate, and stop the old app/runtime owners before activate/rollback.
 * No elevation, launch, deletion of the previous bundle or state migration occurs here.
 */
export function createApplicationSwapper(verify: Verify = createMacApplicationVerifier()) {
 return {
  async discardPrepared(swap: ApplicationSwap): Promise<void> {
   const loc = await load(swap);
   if (loc.journal.phase !== "prepared" || await exists(loc.previous)) throw new Error("UPDATE_APPLICATION_ALREADY_STARTED");
   await rm(loc.directory, {recursive: true}); await sync(loc.parent);
  },
  async verifyOutcome(swap: ApplicationSwap, outcome: "installed" | "restored"): Promise<void> {
   try {
    const {journal} = await load(swap);
    if (journal.phase !== outcome) throw new Error();
    await verify(swap.application, {teamId: journal.teamId, version: outcome === "installed" ? journal.nextVersion : journal.previousVersion});
   } catch {throw new Error("UPDATE_APPLICATION_OUTCOME_INVALID");}
  },
  async prepare(input: {application: string; candidate: string; teamId: string; previousVersion: string; nextVersion: string}): Promise<ApplicationSwap> {
   let ownedDirectory: string | undefined;
   try {
    if (compareUpdateVersions(input.nextVersion, input.previousVersion) <= 0) throw new Error();
    const application = await realBundle(input.application), candidate = await realBundle(input.candidate);
    if (application === candidate || candidate.startsWith(application + path.sep) || application.startsWith(candidate + path.sep)) throw new Error();
    await verify(application, {teamId: input.teamId, version: input.previousVersion});
    await verify(candidate, {teamId: input.teamId, version: input.nextVersion});
    await checkTree(candidate, false);
    const id = randomUUID(), parent = path.dirname(application), directory = path.join(parent, `.zhivex-update-${id}`);
    await mkdir(directory, {mode: 0o700}); ownedDirectory = directory; await sync(parent);
    const next = path.join(directory, "next.app");
    // A sibling staging directory keeps replacement/rollback renames on the installation volume.
    await cp(candidate, next, {recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false});
    await checkTree(next, true);
    await verify(next, {teamId: input.teamId, version: input.nextVersion});
    const journal = schema.parse({schemaVersion: 1, application, teamId: input.teamId, previousVersion: input.previousVersion, nextVersion: input.nextVersion, phase: "prepared"});
    await save(directory, journal); return {application, id};
   } catch {
    if (ownedDirectory) try {await rm(ownedDirectory, {recursive: true, force: true});} catch {throw new Error("UPDATE_APPLICATION_CLEANUP_FAILED");}
    throw new Error("UPDATE_APPLICATION_PREPARE_FAILED");
   }
  },
  async activate(swap: ApplicationSwap, options: {assertStopped(): Promise<void>; afterMove?: (step: number) => Promise<void>}): Promise<void> {
   try {
    const loc = await load(swap), {journal} = loc;
    await options.assertStopped();
    if (journal.phase === "installed") {await verify(swap.application, {teamId: journal.teamId, version: journal.nextVersion}); return;}
    if (journal.phase !== "prepared" || await exists(loc.previous)) throw new Error();
    await verify(swap.application, {teamId: journal.teamId, version: journal.previousVersion});
    await verify(loc.next, {teamId: journal.teamId, version: journal.nextVersion});
    await options.assertStopped(); journal.phase = "swapping"; await save(loc.directory, journal);
    await rename(swap.application, loc.previous); await sync(loc.parent); await sync(loc.directory); await options.afterMove?.(1);
    await rename(loc.next, swap.application); await sync(loc.parent); await sync(loc.directory); await options.afterMove?.(2);
    await verify(swap.application, {teamId: journal.teamId, version: journal.nextVersion});
    journal.phase = "installed"; await save(loc.directory, journal);
   } catch {throw new Error("UPDATE_APPLICATION_ACTIVATE_FAILED");}
  },
  async rollback(swap: ApplicationSwap, options: {assertStopped(): Promise<void>; afterMove?: (step: number) => Promise<void>}): Promise<void> {
   try {
    const loc = await load(swap), {journal} = loc; await options.assertStopped();
    if (!await exists(loc.previous)) {
     // Covers prepared, a crash before the first swap move, and a crash after rollback's last move.
     await verify(swap.application, {teamId: journal.teamId, version: journal.previousVersion});
     journal.phase = "restored"; await save(loc.directory, journal); return;
    }
    await verify(loc.previous, {teamId: journal.teamId, version: journal.previousVersion});
    await options.assertStopped(); journal.phase = "rolling-back"; await save(loc.directory, journal);
    if (await exists(swap.application)) {
     await realBundle(swap.application);
     await rename(swap.application, path.join(loc.directory, `failed-${randomUUID()}.app`)); await sync(loc.parent); await sync(loc.directory); await options.afterMove?.(1);
    }
    await rename(loc.previous, swap.application); await sync(loc.parent); await sync(loc.directory); await options.afterMove?.(2);
    await verify(swap.application, {teamId: journal.teamId, version: journal.previousVersion});
    journal.phase = "restored"; await save(loc.directory, journal);
   } catch {throw new Error("UPDATE_APPLICATION_ROLLBACK_FAILED");}
  },
 };
}
