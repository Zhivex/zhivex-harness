import {test, expect} from "bun:test";
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import type {AgentRunState} from "@zhivex-ai/agents";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {openHarnessActivityStore} from "../../src/service-events.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import {createDesktopDatabaseBackup, verifyDesktopDatabaseBackup} from "../src/database-backup.js";

async function fixture(run: (f: {root: string; config: ReturnType<typeof resolveHarnessConfig>; database: string; sessionId: string}) => Promise<void>) {
 const root = await mkdtemp("/tmp/har-database-backup-");
 const workspace = path.join(root, "repo"), stateDirectory = path.join(root, "state");
 await mkdir(workspace); await mkdir(stateDirectory, {mode: 0o700});
 const config = resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"});
 const persistence = await openHarnessPersistence(config);
 const state: AgentRunState = {schemaVersion: 1, revision: 0, runId: "saved-run", provider: "openai", modelId: "fixture", status: "completed", messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 2, outputText: "finished", pendingApprovals: [], compactions: [], scope: config.scope, startedAt: 1000, updatedAt: 2000};
 await persistence.store.save(state); persistence.close();
 const sessions = await openCliSessionStore({workspace, stateDirectory, scope: config.scope});
 const session = await sessions.create({title: "Saved conversation", initialRun: {runId: state.runId, provider: "openai", model: "fixture", status: "completed"}}); sessions.close();
 const activity = await openHarnessActivityStore(config);
 activity.prompt(session.sessionId, state.runId, "Remember this prompt"); activity.checkpoint(session.sessionId, state.runId, "completed"); activity.close();
 try {await run({root, config, database: path.join(stateDirectory, HARNESS_SQLITE_FILE), sessionId: session.sessionId});}
 finally {await rm(root, {recursive: true, force: true});}
}
test("complete SQLite backup preserves WAL updates, visual activity, indexes and additional tables", () => fixture(async f => {
 const source = new SqliteDatabase(f.database);
 source.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE future_data(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX future_value ON future_data(value)");
 source.query("INSERT INTO future_data(value) VALUES (?)").run("committed in WAL");
 try {
  const before = await readFile(f.database);
  const backup = await createDesktopDatabaseBackup(f.config, path.join(f.root, "backups"));
  await verifyDesktopDatabaseBackup(backup);
  expect(await readFile(f.database)).toEqual(before);
  const restored = new SqliteDatabase(path.join(backup.directory, HARNESS_SQLITE_FILE), {readonly: true});
  try {
   expect(restored.query("SELECT value FROM future_data").get()).toEqual({value: "committed in WAL"});
   expect(restored.query("SELECT title FROM zhivex_cli_sessions").get()).toEqual({title: "Saved conversation"});
   expect(restored.query<{n: number}>("SELECT count(*) AS n FROM client_activity_events").get()!.n).toBeGreaterThan(0);
   expect(restored.query<{n: number}>("SELECT count(*) AS n FROM client_activity_snapshots").get()!.n).toBeGreaterThan(0);
   expect(restored.query("SELECT name FROM sqlite_master WHERE name='future_value'").get()).toEqual({name: "future_value"});
  } finally {restored.close();}
  source.query("INSERT INTO future_data(value) VALUES (?)").run("later change");
  await verifyDesktopDatabaseBackup(backup);
 } finally {source.close();}
}));
test("tampering and non-private permissions reject recovery receipt", () => fixture(async f => {
 const backup = await createDesktopDatabaseBackup(f.config, path.join(f.root, "backups"));
 const filename = path.join(backup.directory, HARNESS_SQLITE_FILE), original = await readFile(filename);
 await chmod(filename, 0o644); await expect(verifyDesktopDatabaseBackup(backup)).rejects.toThrow("DESKTOP_BACKUP_INVALID"); await chmod(filename, 0o600);
 await writeFile(filename, Buffer.alloc(original.length)); await expect(verifyDesktopDatabaseBackup(backup)).rejects.toThrow("DESKTOP_BACKUP_INVALID");
}));
test("active work in another scope and orphan leases prevent whole-database backup", () => fixture(async f => {
 const db = new SqliteDatabase(f.database), root = path.join(f.root, "backups");
 try {
  db.exec("UPDATE zhivex_agent_runs SET state_json=json_set(state_json,'$.status','running','$.scope.tenantId','another-tenant')");
  await expect(createDesktopDatabaseBackup(f.config, root)).rejects.toThrow("DESKTOP_BACKUP_FAILED"); expect(await readdir(root)).toEqual([]);
  db.exec("UPDATE zhivex_agent_runs SET state_json=json_set(state_json,'$.status','completed')");
  db.query("INSERT INTO zhivex_agent_runs_leases(run_key,run_id,owner_id,expires_at_ms) VALUES(?,?,?,?)").run("orphan-key", "orphan", "fixture", Date.now() + 60_000);
  await expect(createDesktopDatabaseBackup(f.config, root)).rejects.toThrow("DESKTOP_BACKUP_FAILED"); expect(await readdir(root)).toEqual([]);
  db.exec("DELETE FROM zhivex_agent_runs_leases");
  const runKey = db.query<{run_id: string}>("SELECT run_id FROM zhivex_agent_runs").get()!.run_id;
  db.query("INSERT INTO zhivex_agent_runs_tool_journal(run_key,tool_call_id,entry_json,revision,updated_at_ms) VALUES(?,?,?,?,?)").run(runKey, "pending-tool", JSON.stringify({status: "running"}), 0, Date.now());
  await expect(createDesktopDatabaseBackup(f.config, root)).rejects.toThrow("DESKTOP_BACKUP_FAILED"); expect(await readdir(root)).toEqual([]);
 } finally {db.close();}
}));
