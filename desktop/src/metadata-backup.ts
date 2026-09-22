import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, mkdtemp, open, readdir, realpath, rm} from "node:fs/promises";
import path from "node:path";
import {readRegularFileNoFollow} from "../../src/internal/desktop/persistence.js";

const fixed = ["projects/projects.json", "tasks/tasks.json", "state-compatibility/format.json"];
const journalRoots = ["git-delivery", "remote-delivery", "pull-requests"];
const projectKey = /^project_[a-f0-9]{32}$/;
const journalName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
const LIMIT = 16 * 1024 * 1024, FILE_LIMIT = 1024 * 1024, COUNT_LIMIT = 4096;
export interface DesktopMetadataBackup {directory: string; files: Array<{name: string; size: number; sha256: string} | {name: string; absent: true}>}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function allowed(name: string) {
 const [root, project, filename, extra] = name.split("/");
 return fixed.includes(name) || (journalRoots.includes(root!) && projectKey.test(project ?? "") && journalName.test(filename ?? "") && extra === undefined);
}
async function directoryExists(directory: string) {
 try {
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error();
  return true;
 } catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error;}
}
async function readPrivate(filename: string) {
 const value = await readRegularFileNoFollow(filename, {label: "desktop metadata", maxBytes: FILE_LIMIT, requireSingleLink: true});
 if (value.stat.uid !== process.getuid?.() || (value.stat.mode & 0o077)) throw new Error();
 return value.contents;
}
async function writePrivate(filename: string, value: Buffer) {
 const parent = path.dirname(filename); await mkdir(parent, {recursive: true, mode: 0o700});
 const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try {await file.writeFile(value); await file.sync();} finally {await file.close();}
 const dir = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW); try {await dir.sync();} finally {await dir.close();}
}
async function metadataNames(userData: string): Promise<string[]> {
  const names = [...fixed];
  for (const root of journalRoots) {
   const base = path.join(userData, root); if (!await directoryExists(base)) continue;
   for (const project of await readdir(base)) {
    if (!projectKey.test(project) || !await directoryExists(path.join(base, project))) throw new Error();
    for (const filename of await readdir(path.join(base, project))) {
     if (!journalName.test(filename)) throw new Error();
     names.push(`${root}/${project}/${filename}`); if (names.length > COUNT_LIMIT) throw new Error();
    }
   }
  }
  return names.sort();
}
/** Host-selected metadata only; no Chromium profile, credentials, repositories or task checkouts.
 * Must execute under the update coordinator with all index/journal mutation admission closed.
 */
export async function createDesktopMetadataBackup(userData: string, backupRoot: string): Promise<DesktopMetadataBackup> {
 let directory: string | undefined;
 try {
  const names = await metadataNames(userData);
  await mkdir(backupRoot, {recursive: true, mode: 0o700}); if (!await directoryExists(backupRoot)) throw new Error();
  directory = await mkdtemp(path.join(await realpath(backupRoot), "metadata-"));
  const files: DesktopMetadataBackup["files"] = []; let size = 0;
  for (const name of names.sort()) {
   let value: Buffer;
   try {value = await readPrivate(path.join(userData, name));}
   catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !fixed.includes(name)) throw error;
    files.push({name, absent: true}); continue;
   }
   size += value.length; if (size > LIMIT) throw new Error();
   await writePrivate(path.join(directory, name), value); files.push({name, size: value.length, sha256: digest(value)});
  }
  // Persist every directory link, including newly created project subdirectories.
  const directories = new Set([directory, path.dirname(directory)]);
  for (const item of files) if (!("absent" in item)) {
   let parent = path.dirname(path.join(directory, item.name));
   while (parent !== directory) {directories.add(parent); parent = path.dirname(parent);}
  }
  for (const parent of [...directories].sort((a, b) => b.length - a.length)) {
   const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW); try {await handle.sync();} finally {await handle.close();}
  }
  return {directory, files};
 } catch {
  if (directory) try {await rm(directory, {recursive: true, force: true});} catch {throw new Error("DESKTOP_BACKUP_CLEANUP_FAILED");}
  throw new Error("DESKTOP_METADATA_BACKUP_FAILED");
 }
}
/** Verify EVERY entry before returning any bytes to recovery. Receipt is trusted host data. */
export async function readDesktopMetadataBackup(backup: DesktopMetadataBackup): Promise<Map<string, Buffer | null>> {
 try {
  if (!await directoryExists(backup.directory) || backup.files.length > COUNT_LIMIT) throw new Error();
  const values = new Map<string, Buffer | null>(); let size = 0;
  for (const item of backup.files) {
   if (!allowed(item.name) || values.has(item.name)) throw new Error();
   if ("absent" in item) {if (!fixed.includes(item.name) || item.absent !== true) throw new Error(); values.set(item.name, null); continue;}
   const bytes = await readPrivate(path.join(backup.directory, item.name)); size += bytes.length;
   if (size > LIMIT || item.size !== bytes.length || item.sha256 !== digest(bytes)) throw new Error();
   values.set(item.name, bytes);
  }
  if (fixed.some(name => !values.has(name))) throw new Error();
  return values;
 } catch {throw new Error("DESKTOP_METADATA_BACKUP_INVALID");}
}

/** Format-1 updates preserve index/journal bytes. The transaction owns and checks
 * the format marker separately; no profile or checkout files are compared.
 */
export async function verifyDesktopMetadataState(userData: string, backup: DesktopMetadataBackup): Promise<void> {
 try {
  const expected = await readDesktopMetadataBackup(backup);
  expected.delete("state-compatibility/format.json");
  const names = (await metadataNames(userData)).filter(name => name !== "state-compatibility/format.json");
  if (JSON.stringify(names) !== JSON.stringify([...expected.keys()].sort())) throw new Error();
  let size = 0;
  for (const name of names) {
   let bytes: Buffer | null = null;
   if (await directoryExists(path.dirname(path.join(userData, name)))) {
    try {bytes = await readPrivate(path.join(userData, name));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !fixed.includes(name)) throw error;}
   }
   size += bytes?.length ?? 0; if (size > LIMIT) throw new Error();
   const original = expected.get(name);
   if (bytes === null ? original !== null : !original || !bytes.equals(original)) throw new Error();
  }
 } catch {throw new Error("DESKTOP_METADATA_STATE_INVALID");}
}
