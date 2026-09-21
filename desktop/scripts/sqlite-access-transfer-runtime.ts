import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import {adoptExclusiveSqliteAccess} from "../../src/sqlite-access.js";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {prepareExclusiveDesktopUpdateState} from "../src/update-inventory.js";
import {launchDesktopUpdateWorker} from "../src/update-worker-launcher.js";
const exists = (file: string) => access(file).then(() => true, () => false);
async function poll(check: () => Promise<boolean>) {const deadline = Date.now() + 8000; while (Date.now() < deadline) {if (await check()) return; await new Promise(r => setTimeout(r, 25));} throw new Error("FIXTURE_TIMEOUT");}
async function host() {
 const f = JSON.parse(await readFile(process.argv[3]!, "utf8")), workerFile = await realpath(process.argv[1]!);
 const project = {key: `project_${createHash("sha256").update(f.workspace).digest("hex").slice(0, 32)}`, workspace: f.workspace, name: "fixture", lastOpenedAt: 1};
 const prepared = await prepareExclusiveDesktopUpdateState(f.userData, [project], []);
 try {
  await writeFile(path.join(f.root, "backup.json"), JSON.stringify(prepared.transaction));
  const worker = await launchDesktopUpdateWorker({directory: path.dirname(workerFile), worker: workerFile, helper: f.helper, executable: process.execPath, arguments: ["worker", process.argv[3]!], stateAccess: prepared.access});
  await writeFile(path.join(f.root, "spawn.json"), JSON.stringify(worker));
  await poll(() => exists(path.join(f.root, "worker-ready"))); await writeFile(path.join(f.root, "host-ready"), String(process.pid));
  await poll(() => exists(path.join(f.root, "host-release")));
 } finally {prepared.releaseAccess();}
}
async function worker() {
 const f = JSON.parse(await readFile(process.argv[3]!, "utf8")), lease = adoptExclusiveSqliteAccess(f.databasePath, 4);
 const db = new SqliteDatabase(f.databasePath, {accessLease: lease});
 try {
  assert.equal(db.query<{n: number}>("SELECT n FROM value").get()!.n, 7);
  await writeFile(path.join(f.root, "worker-ready"), String(process.pid));
  await poll(() => exists(path.join(f.root, "worker-release")));
 } finally {db.close(); lease.close();}
}
async function parent() {
 const root = await realpath(await mkdtemp("/tmp/har-native-transfer-")), workspace = path.join(root, "workspace"), userData = path.join(root, "profile");
 let child: ReturnType<typeof spawn> | undefined;
 try {
  await mkdir(workspace); await mkdir(userData, {mode: 0o700});
  const config = resolveHarnessConfig({workspace, provider: "openai", storeBackend: "sqlite"}), databasePath = path.join(config.stateDirectory, HARNESS_SQLITE_FILE);
  const persistence = await openHarnessPersistence(config); persistence.close();
  const sessions = await openCliSessionStore({workspace, stateDirectory: config.stateDirectory, scope: config.scope}); await sessions.create({title: "native retained"}); sessions.close();
  const initial = new SqliteDatabase(databasePath); initial.exec("CREATE TABLE value(n INTEGER); INSERT INTO value VALUES(7)"); initial.close();
  const fixture = path.join(root, "fixture.json"); await writeFile(fixture, JSON.stringify({root, workspace, userData, databasePath, helper: await realpath(process.argv[2]!)}), {mode: 0o600});
  child = spawn(process.execPath, [process.argv[1]!, "host", fixture], {stdio: "ignore", env: {PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1"}});
  const exited = new Promise<number | null>((resolve, reject) => {child!.once("exit", resolve); child!.once("error", reject);});
  await poll(() => exists(path.join(root, "host-ready")));
  const backup = JSON.parse(await readFile(path.join(root, "backup.json"), "utf8")); assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  const receipt = JSON.parse(await readFile(path.join(userData, "update-recovery", backup.id, "receipt.json"), "utf8"));
  const copy = new SqliteDatabase(path.join(userData, "update-recovery", backup.id, receipt.databases[0].backup.directory, HARNESS_SQLITE_FILE), {readonly: true});
  try {assert.equal(copy.query<{n: number}>("SELECT n FROM value").get()!.n, 7); assert.equal(copy.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title, "native retained");} finally {copy.close();}
  assert.throws(() => new SqliteDatabase(databasePath), /SQLITE_ACCESS_UNAVAILABLE/);
  await writeFile(path.join(root, "host-release"), ""); assert.equal(await exited, 0);
  assert.throws(() => new SqliteDatabase(databasePath), /SQLITE_ACCESS_UNAVAILABLE/);
  const {pid} = JSON.parse(await readFile(path.join(root, "spawn.json"), "utf8")); process.kill(pid, 0); process.kill(pid, "SIGKILL");
  await poll(async () => {try {process.kill(pid, 0); return false;} catch {return true;}});
  const reopened = new SqliteDatabase(databasePath); try {assert.equal(reopened.query<{n: number}>("SELECT n FROM value").get()!.n, 7);} finally {reopened.close();}
  const evidence = await mkdtemp("/tmp/har-transfer-report-");
  const report = {node: process.versions.node, electron: process.versions.electron, exclusiveBackupPrepared: true, snapshotRecordsVerified: true, exclusiveBeforeHostExit: true, exclusiveAfterHostExit: true, inheritedLeaseUsedByWorker: true, workerCrashReleasesLease: true, contentsPreserved: true, pass: true};
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report}));
 } finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {const {pid} = JSON.parse(await readFile(path.join(root, "spawn.json"), "utf8")); process.kill(-pid, "SIGKILL");} catch {}
  await rm(root, {recursive: true, force: true});
 }
}
void (process.argv[2] === "host" ? host() : process.argv[2] === "worker" ? worker() : parent()).catch(() => {console.error("NATIVE_SQLITE_TRANSFER_FAILED"); process.exitCode = 1;});
