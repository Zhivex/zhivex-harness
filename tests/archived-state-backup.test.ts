import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, realpath, rm, rename, symlink} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../src/runtime/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../src/persistence/operations.js";
import {openCliSessionStore} from "../src/persistence/sessions.js";
import {SqliteDatabase} from "../src/persistence/sqlite-database.js";
import {createHarnessStateBackup, createArchivedHarnessStateBackup} from "../src/persistence/state-backup.js";
async function fixture(run: (f: {root: string; config: ReturnType<typeof resolveHarnessConfig>; filename: string; original: Awaited<ReturnType<typeof createHarnessStateBackup>>}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-archived-backup-")), workspace = path.join(root, "checkout"), stateDirectory = path.join(root, "state"); await mkdir(workspace);
 const config = resolveHarnessConfig({workspace, stateDirectory, provider: "openai", storeBackend: "sqlite"});
 const persistence = await openHarnessPersistence(config); persistence.close(); const sessions = await openCliSessionStore({workspace, stateDirectory, scope: config.scope});
 await sessions.create({title: "original archive"}); sessions.close();
 const original = await createHarnessStateBackup(config), filename = path.join(stateDirectory, HARNESS_SQLITE_FILE);
 const owner = new SqliteDatabase(filename); owner.query("SELECT count(*) FROM sqlite_master").get();
 try {await rm(workspace, {recursive: true}); await run({root, config, filename, original});} finally {owner.close(); await rm(root, {recursive: true, force: true});}
}
test("archive reader retains the exact workspace/scope binding and reads without migrating or recreating checkout", () => fixture(async f => {
 const before = await readFile(f.filename), archive = await createArchivedHarnessStateBackup(f.config);
 expect(archive.binding).toEqual(f.original.binding); expect(archive.records).toEqual(f.original.records);
 expect(await readFile(f.filename)).toEqual(before); await expect(realpath(f.config.workspace)).rejects.toThrow();
}));
test("incompatible archived schema is rejected without resetting it", () => fixture(async f => {
 const db = new SqliteDatabase(f.filename); try {db.exec("UPDATE zhivex_cli_session_schema SET version=999");} finally {db.close();}
 await expect(createArchivedHarnessStateBackup(f.config)).rejects.toThrow("Archived session schema is incompatible");
 const check = new SqliteDatabase(f.filename); try {expect(check.query<{version: number}>("SELECT version FROM zhivex_cli_session_schema").get()!.version).toBe(999);} finally {check.close();}
}));
test("archive identity refuses a replaced canonical ancestor", () => fixture(async f => {
 const moved = f.root + "-moved"; await rename(f.root, moved); await symlink(moved, f.root);
 try {await expect(createArchivedHarnessStateBackup(f.config)).rejects.toThrow("RECORDED_WORKSPACE_INVALID");}
 finally {await rm(f.root); await rename(moved, f.root);}
}));
