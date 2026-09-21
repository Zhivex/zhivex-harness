import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {openHarnessActivityStore} from "../../src/service-events.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import {checkDesktopStateFormat} from "../src/state-format.js";
import {prepareDesktopStateTransaction, armDesktopStateTransaction, restoreDesktopStateTransaction, finishDesktopStateTransaction} from "../src/state-transaction.js";

async function fixture(run: (f: {root: string; userData: string; configs: ReturnType<typeof resolveHarnessConfig>[]}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-state-transaction-")), userData = path.join(root, "profile"); await mkdir(userData);
 const configs = [];
 for (let i = 0; i < 2; i++) {
  const workspace = path.join(root, `repo${i}`), stateDirectory = path.join(root, `state${i}`); await mkdir(workspace); await mkdir(stateDirectory, {mode: 0o700});
  const config = resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"});
  const p = await openHarnessPersistence(config); p.close();
  const sessions = await openCliSessionStore({workspace, stateDirectory, scope: config.scope});
  const session = await sessions.create({title: `original ${i}`}); sessions.close();
  const activity = await openHarnessActivityStore(config); activity.prompt(session.sessionId, "fixture", `original prompt ${i}`); activity.checkpoint(session.sessionId, "fixture", "completed"); activity.close();
  configs.push(config);
 }
 await mkdir(path.join(userData, "projects"), {mode: 0o700}); await writeFile(path.join(userData, "projects/projects.json"), '{"schemaVersion":1,"projects":[]}', {mode: 0o600});
 try {await run({root, userData, configs});} finally {await rm(root, {recursive: true, force: true});}
}
// Production takes the backup while paused hosts still own their SQLite connections.
// Keep equivalent handles here; the separate native Electron fixture also certifies closed databases.
async function prepare(userData: string, configs: ReturnType<typeof resolveHarnessConfig>[]) {
 const hosts = configs.map(c => new SqliteDatabase(path.join(c.stateDirectory, HARNESS_SQLITE_FILE)));
 try {for (const host of hosts) host.query("SELECT count(*) FROM sqlite_master").get(); return await prepareDesktopStateTransaction(userData, configs);} finally {for (const host of hosts) host.close();}
}
function mutate(config: ReturnType<typeof resolveHarnessConfig>) {
 const db = new SqliteDatabase(path.join(config.stateDirectory, HARNESS_SQLITE_FILE));
 try {db.exec("UPDATE zhivex_cli_sessions SET title='changed by migration'; DELETE FROM client_activity_events; CREATE TABLE migration_table(value TEXT)");} finally {db.close();}
}
function title(config: ReturnType<typeof resolveHarnessConfig>) {
 const db = new SqliteDatabase(path.join(config.stateDirectory, HARNESS_SQLITE_FILE));
 try {return db.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title;} finally {db.close();}
}
test("persistent recovery restores two databases and metadata after interrupted migration; marker waits for binary confirmation", () => fixture(async f => {
 const transaction = await prepare(f.userData, f.configs); await armDesktopStateTransaction(f.userData, transaction);
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 f.configs.forEach(mutate); await writeFile(path.join(f.userData, "projects/projects.json"), "changed index");
 const newJournal = path.join(f.userData, "remote-delivery", `project_${"b".repeat(32)}`);
 await mkdir(newJournal, {recursive: true, mode: 0o700}); await writeFile(path.join(newJournal, "00000000-0000-4000-8000-000000000001.json"), "migration journal", {mode: 0o600});
 await mkdir(path.join(f.userData, "tasks"), {mode: 0o700}); await writeFile(path.join(f.userData, "tasks/tasks.json"), "new index", {mode: 0o600});
 let writes = 0;
 await expect(restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {}, afterWrite: async () => {if (++writes === 1) throw new Error("power failure fixture");}})).rejects.toThrow("DESKTOP_STATE_RESTORE_FAILED");
 expect(title(f.configs[0]!)).toBe("original 0"); expect(title(f.configs[1]!)).toBe("changed by migration");
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 // Recovery uses only the on-disk pointer, not the original transaction object.
 await restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {}});
 for (const [i, config] of f.configs.entries()) {
  expect(title(config)).toBe(`original ${i}`);
  const db = new SqliteDatabase(path.join(config.stateDirectory, HARNESS_SQLITE_FILE));
  try {expect(db.query<{n: number}>("SELECT count(*) AS n FROM client_activity_events").get()!.n).toBeGreaterThan(0); expect(db.query("SELECT name FROM sqlite_master WHERE name='migration_table'").get()).toBeUndefined();} finally {db.close();}
  expect((await readdir(path.join(config.stateDirectory, `.update-recovery-${transaction.id}`))).length).toBeGreaterThan(0);
 }
 expect(await readFile(path.join(f.userData, "projects/projects.json"), "utf8")).toBe('{"schemaVersion":1,"projects":[]}');
 expect(await readdir(path.join(f.userData, "tasks"))).toEqual([]);
 expect(await readdir(newJournal)).toEqual([]);
 await expect(finishDesktopStateTransaction(f.userData, async () => {throw new Error("binary not restored");})).rejects.toThrow("DESKTOP_STATE_FINISH_FAILED");
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 await finishDesktopStateTransaction(f.userData, async () => {}); await checkDesktopStateFormat(f.userData);
 expect(await readdir(path.join(f.userData, "update-recovery"))).toContain(transaction.id);
}));
test("corrupt backup is detected before either destination changes", () => fixture(async f => {
 const t = await prepare(f.userData, f.configs); await armDesktopStateTransaction(f.userData, t); f.configs.forEach(mutate);
 const directory = path.join(f.userData, "update-recovery", t.id);
 const receipt = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8"));
 await writeFile(path.join(directory, receipt.databases[1].backup.directory, HARNESS_SQLITE_FILE), "corrupt");
 await expect(restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {}})).rejects.toThrow("DESKTOP_STATE_RESTORE_FAILED");
 expect(f.configs.map(title)).toEqual(["changed by migration", "changed by migration"]);
}));
test("changed receipt or an unconfirmed live owner refuses restoration", () => fixture(async f => {
 const t = await prepare(f.userData, f.configs); await armDesktopStateTransaction(f.userData, t); f.configs.forEach(mutate);
 await expect(restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {throw new Error("live owner");}})).rejects.toThrow("DESKTOP_STATE_RESTORE_FAILED");
 expect(f.configs.map(title)).toEqual(["changed by migration", "changed by migration"]);
 await writeFile(path.join(f.userData, "update-recovery", t.id, "receipt.json"), "changed receipt");
 await expect(restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {}})).rejects.toThrow("DESKTOP_STATE_RESTORE_FAILED");
 expect(f.configs.map(title)).toEqual(["changed by migration", "changed by migration"]);
}));
test("recovery intent alone blocks startup before any format initialization", () => fixture(async f => {
 await mkdir(path.join(f.userData, "update-recovery"), {mode: 0o700}); await writeFile(path.join(f.userData, "update-recovery/active.json"), "partial intent", {mode: 0o600});
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 expect(await readdir(f.userData)).not.toContain("state-compatibility");
}));
test("state absent before migration returns to absence while new DB and orphan sidecars are preserved", () => fixture(async f => {
 const workspace = path.join(f.root, "new-repo"), stateDirectory = path.join(f.root, "new-state"); await mkdir(workspace);
 const fresh = resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"});
 // Keep existing DB owners open for the Bun snapshot fixture; the new state does not exist yet.
 const hosts = f.configs.map(c => new SqliteDatabase(path.join(c.stateDirectory, HARNESS_SQLITE_FILE)));
 let t;
 try {for (const h of hosts) h.query("SELECT count(*) FROM sqlite_master").get(); t = await prepareDesktopStateTransaction(f.userData, [...f.configs, fresh]);} finally {hosts.forEach(h => h.close());}
 await armDesktopStateTransaction(f.userData, t);
 await mkdir(stateDirectory, {mode: 0o700});
 for (const suffix of ["", "-wal", "-shm"]) await writeFile(path.join(stateDirectory, HARNESS_SQLITE_FILE + suffix), `new${suffix}`, {mode: 0o600});
 await restoreDesktopStateTransaction(f.userData, {assertStopped: async () => {}});
 expect(await readdir(stateDirectory)).toEqual([`.update-recovery-${t.id}`]);
 const saved = path.join(stateDirectory, `.update-recovery-${t.id}`);
 expect((await Promise.all((await readdir(saved)).map(n => readFile(path.join(saved, n), "utf8")))).sort()).toEqual(["new", "new-shm", "new-wal"]);
}));
