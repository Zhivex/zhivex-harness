import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {openHarnessActivityStore} from "../../src/service-events.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import {createDesktopDatabaseBackup, verifyDesktopDatabaseBackup} from "../src/database-backup.js";
import {createDesktopMetadataBackup, readDesktopMetadataBackup} from "../src/metadata-backup.js";

async function main() {
 const root = await mkdtemp("/tmp/har-native-backup-"), workspace = path.join(root, "repo"), stateDirectory = path.join(root, "state"), userData = path.join(root, "profile");
 await mkdir(workspace); await mkdir(stateDirectory, {mode: 0o700}); await mkdir(path.join(userData, "projects"), {recursive: true, mode: 0o700});
 const config = resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"});
 const persistence = await openHarnessPersistence(config); persistence.close();
 const sessions = await openCliSessionStore({workspace, stateDirectory, scope: config.scope});
 const session = await sessions.create({title: "Native backup fixture"}); sessions.close();
 const activity = await openHarnessActivityStore(config); activity.prompt(session.sessionId, "fixture", "Keep visual history"); activity.checkpoint(session.sessionId, "fixture", "completed"); activity.close();
 const source = new SqliteDatabase(path.join(stateDirectory, HARNESS_SQLITE_FILE));
 try {
  source.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_probe(id INTEGER PRIMARY KEY, value TEXT)"); source.query("INSERT INTO wal_probe(value) VALUES(?)").run("preserved WAL");
  const before = await readFile(path.join(stateDirectory, HARNESS_SQLITE_FILE));
  const backup = await createDesktopDatabaseBackup(config, path.join(root, "backups")); await verifyDesktopDatabaseBackup(backup);
  const copy = new SqliteDatabase(path.join(backup.directory, HARNESS_SQLITE_FILE), {readonly: true});
  let checks;
  try {checks = {
   originalUnchanged: before.equals(await readFile(path.join(stateDirectory, HARNESS_SQLITE_FILE))),
   walContent: copy.query<{value: string}>("SELECT value FROM wal_probe").get()?.value === "preserved WAL",
   conversation: copy.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()?.title === "Native backup fixture",
   visualEvents: copy.query<{n: number}>("SELECT count(*) AS n FROM client_activity_events").get()!.n > 0,
   visualSnapshots: copy.query<{n: number}>("SELECT count(*) AS n FROM client_activity_snapshots").get()!.n > 0,
  };} finally {copy.close();}
  await writeFile(path.join(userData, "projects/projects.json"), '{"schemaVersion":1,"projects":[]}', {mode: 0o600});
  const metadata = await createDesktopMetadataBackup(userData, path.join(root, "backups")); const restored = await readDesktopMetadataBackup(metadata);
  const metadataPreserved = restored.get("projects/projects.json")?.toString() === '{"schemaVersion":1,"projects":[]}' && restored.get("tasks/tasks.json") === null;
  const report = {node: process.versions.node, electron: process.versions.electron, ...checks, metadataPreserved, pass: Object.values(checks).every(Boolean) && metadataPreserved};
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({root, ...report}));
  if (!report.pass) throw new Error("NATIVE_BACKUP_CHECK_FAILED");
 } finally {source.close();}
}
void main().catch(() => {console.error("NATIVE_BACKUP_CHECK_FAILED"); process.exitCode = 1;});
