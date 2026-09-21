import {test, expect} from "bun:test";
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {createDesktopMetadataBackup, readDesktopMetadataBackup, verifyDesktopMetadataState} from "../src/metadata-backup.js";
async function fixture(run: (root: string, userData: string) => Promise<void>) {
 const root = await mkdtemp("/tmp/har-metadata-backup-"), userData = path.join(root, "profile"); await mkdir(userData);
 try {await run(root, userData);} finally {await rm(root, {recursive: true, force: true});}
}
const journal = `project_${"a".repeat(32)}/00000000-0000-4000-8000-000000000001.json`;
async function write(directory: string, name: string, value: string) {const f = path.join(directory, name); await mkdir(path.dirname(f), {recursive: true, mode: 0o700}); await writeFile(f, value, {mode: 0o600});}
test("backup preserves desktop indexes and all delivery journals without copying checkout/profile data", () => fixture(async (root, userData) => {
 const sources = new Map([
  ["projects/projects.json", '{"schemaVersion":1,"projects":[]}'], ["tasks/tasks.json", '{"schemaVersion":1,"tasks":[]}'],
  ["state-compatibility/format.json", '{"format":1,"phase":"ready"}'],
  [`git-delivery/${journal}`, '{"status":"completed"}'], [`remote-delivery/${journal}`, '{"status":"confirmed"}'], [`pull-requests/${journal}`, '{"status":"completed"}'],
 ]);
 for (const [name, value] of sources) await write(userData, name, value);
 await write(userData, "tasks/fixture/checkout/work.txt", "local user edits"); await write(userData, "Cookies", "private profile data");
 const backup = await createDesktopMetadataBackup(userData, path.join(root, "backups"));
 const values = await readDesktopMetadataBackup(backup);
 expect([...values.keys()].sort()).toEqual([...sources.keys()].sort());
 for (const [name, value] of sources) {expect(values.get(name)?.toString()).toBe(value); expect(await readFile(path.join(userData, name), "utf8")).toBe(value);}
 expect(await readdir(path.join(backup.directory, "tasks"))).toEqual(["tasks.json"]);
}));
test("missing indexes are explicit so rollback can preserve their absence", () => fixture(async (root, userData) => {
 const backup = await createDesktopMetadataBackup(userData, path.join(root, "backups"));
 expect([...(await readDesktopMetadataBackup(backup)).values()]).toEqual([null, null, null]);
}));
test("tampering, duplicate entries and traversal are rejected before recovery receives bytes", () => fixture(async (root, userData) => {
 await write(userData, "projects/projects.json", "original");
 const backup = await createDesktopMetadataBackup(userData, path.join(root, "backups"));
 await expect(readDesktopMetadataBackup({...backup, files: [...backup.files, backup.files[0]!]})).rejects.toThrow("DESKTOP_METADATA_BACKUP_INVALID");
 await expect(readDesktopMetadataBackup({...backup, files: [{name: "../outside", absent: true}]})).rejects.toThrow("DESKTOP_METADATA_BACKUP_INVALID");
 await writeFile(path.join(backup.directory, "projects/projects.json"), "tampered");
 await expect(readDesktopMetadataBackup(backup)).rejects.toThrow("DESKTOP_METADATA_BACKUP_INVALID");
}));
test("symlinked metadata refuses backup and clears partial staging", () => fixture(async (root, userData) => {
 await mkdir(path.join(userData, "projects")); await symlink(path.join(root, "target"), path.join(userData, "projects/projects.json"));
 const backups = path.join(root, "backups");
 await expect(createDesktopMetadataBackup(userData, backups)).rejects.toThrow("DESKTOP_METADATA_BACKUP_FAILED"); expect(await readdir(backups)).toEqual([]);
}));
test("live verification ignores the transaction marker but detects added, removed and changed metadata", () => fixture(async (root, userData) => {
 await write(userData, "projects/projects.json", "original");
 await write(userData, `git-delivery/${journal}`, "original journal");
 const backup = await createDesktopMetadataBackup(userData, path.join(root, "backups"));
 await write(userData, "state-compatibility/format.json", '{"format":1,"phase":"migrating"}');
 await verifyDesktopMetadataState(userData, backup);
 await write(userData, `remote-delivery/${journal}`, "new journal");
 await expect(verifyDesktopMetadataState(userData, backup)).rejects.toThrow("DESKTOP_METADATA_STATE_INVALID");
 await rm(path.join(userData, `remote-delivery/${journal}`));
 await rm(path.join(userData, `git-delivery/${journal}`));
 await expect(verifyDesktopMetadataState(userData, backup)).rejects.toThrow("DESKTOP_METADATA_STATE_INVALID");
 await write(userData, `git-delivery/${journal}`, "original journal");
 await write(userData, "projects/projects.json", "changed");
 await expect(verifyDesktopMetadataState(userData, backup)).rejects.toThrow("DESKTOP_METADATA_STATE_INVALID");
 expect(await readFile(path.join(userData, "projects/projects.json"), "utf8")).toBe("changed");
}));
test("live verification rejects a symlinked fixed-index parent", () => fixture(async (root, userData) => {
 const backup = await createDesktopMetadataBackup(userData, path.join(root, "backups"));
 const outside = path.join(root, "outside"); await mkdir(outside, {mode: 0o700}); await symlink(outside, path.join(userData, "projects"));
 await expect(verifyDesktopMetadataState(userData, backup)).rejects.toThrow("DESKTOP_METADATA_STATE_INVALID");
}));
