import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {prepareExclusiveDesktopUpdateState} from "../src/update-inventory.js";
import {launchDesktopUpdateWorker} from "../src/update-worker-launcher.js";
import {createApplicationSwapper} from "../src/application-swap.js";
import {prepareDesktopUpdateJob, executeDesktopUpdateJob} from "../src/update-job.js";
import {armDesktopStateTransaction} from "../src/state-transaction.js";
import {checkDesktopStateFormat} from "../src/state-format.js";
import {verifyDesktopDatabaseState} from "../src/database-backup.js";
import {prepareDesktopUpdateHandoff, adoptDesktopUpdateHandoffState, acknowledgeDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement, waitForDesktopUpdateOwners, assertDesktopUpdateOwnersStopped} from "../src/update-handoff.js";
const swapper = createApplicationSwapper(async (bundle, policy) => {assert.equal(await readFile(path.join(bundle, "version"), "utf8"), policy.version);});
const exists = (file: string) => access(file).then(() => true, () => false);
async function poll(check: () => Promise<boolean>) {const deadline = Date.now() + 8000; while (Date.now() < deadline) {if (await check()) return; await new Promise(r => setTimeout(r, 25));} throw new Error("FIXTURE_TIMEOUT");}
async function host() {
 const f = JSON.parse(await readFile(process.argv[3]!, "utf8")), workerFile = await realpath(process.argv[1]!);
 const project = {key: `project_${createHash("sha256").update(f.workspace).digest("hex").slice(0, 32)}`, workspace: f.workspace, name: "fixture", lastOpenedAt: 1};
 const prepared = await prepareExclusiveDesktopUpdateState(f.userData, [project], []);
 try {
  await writeFile(path.join(f.root, "backup.json"), JSON.stringify(prepared.transaction));
  const swap = await swapper.prepare({application: f.application, candidate: f.candidate, teamId: "ABCDEFGHIJ", previousVersion: "1.0.0", nextVersion: "1.1.0"});
  await armDesktopStateTransaction(f.userData, prepared.transaction);
  const job = await prepareDesktopUpdateJob(f.userData, prepared.transaction, swap), handoff = await prepareDesktopUpdateHandoff(job, [], prepared.access);
  const worker = await launchDesktopUpdateWorker({directory: path.dirname(workerFile), worker: workerFile, helper: f.helper, executable: process.execPath, arguments: ["worker", process.argv[3]!, handoff.nonce, handoff.sha256, job.id], stateAccess: f.missingStateFd ? [] : prepared.access});
  await writeFile(path.join(f.root, "spawn.json"), JSON.stringify(worker));
  await waitForDesktopUpdateAcknowledgement(handoff, worker.pid); await writeFile(path.join(f.root, "host-ready"), String(process.pid));
  await poll(() => exists(path.join(f.root, "host-release")));
 } finally {prepared.releaseAccess();}
}
async function worker() {
 const f = JSON.parse(await readFile(process.argv[3]!, "utf8")), handoff = {job: {userData: f.userData, id: process.argv[6]!}, nonce: process.argv[4]!, sha256: process.argv[5]!};
 const access = await adoptDesktopUpdateHandoffState(handoff);
 try {
  await acknowledgeDesktopUpdateHandoff(handoff, access);
  await waitForDesktopUpdateOwners(handoff, {stateAccess: access});
  await poll(() => exists(path.join(f.root, "worker-release")));
  const entry = access.entries[0]!, config = {...resolveHarnessConfig({workspace: f.workspace, stateDirectory: path.dirname(entry.databasePath), storeBackend: "sqlite", provider: "openai"}), accessLease: entry.lease};
  const stateBytes = async () => Promise.all(["", "-wal"].map(async suffix => exists(entry.databasePath + suffix).then(async present => {const bytes = present ? await readFile(entry.databasePath + suffix) : null; return bytes?.length ? bytes : null;})));
  const beforeVerification = await stateBytes();
  await verifyDesktopDatabaseState(config);
  assert.deepEqual(await stateBytes(), beforeVerification);
  const incompatible = new SqliteDatabase(entry.databasePath, {accessLease: entry.lease});
  let originalVersion: number;
  try {originalVersion = incompatible.query<{version: number}>("SELECT version FROM zhivex_cli_session_schema WHERE singleton=1").get()!.version; incompatible.exec("UPDATE zhivex_cli_session_schema SET version=999999 WHERE singleton=1");} finally {incompatible.close();}
  const beforeRejection = await stateBytes();
  await assert.rejects(verifyDesktopDatabaseState(config), /DESKTOP_DATABASE_STATE_INVALID/);
  assert.deepEqual(await stateBytes(), beforeRejection);
  const unchanged = new SqliteDatabase(entry.databasePath, {accessLease: entry.lease});
  try {assert.equal(unchanged.query<{version: number}>("SELECT version FROM zhivex_cli_session_schema WHERE singleton=1").get()!.version, 999999); unchanged.query("UPDATE zhivex_cli_session_schema SET version=? WHERE singleton=1").run(originalVersion);} finally {unchanged.close();}
  const outcome = await executeDesktopUpdateJob(handoff.job, {swapper, assertStopped: () => assertDesktopUpdateOwnersStopped(handoff, access), verifyState: async () => {
   await verifyDesktopDatabaseState(config);
   const entry = access.entries[0]!; assert.equal(entry.databasePath, f.databasePath);
   const db = new SqliteDatabase(entry.databasePath, {accessLease: entry.lease});
   try {assert.equal(db.query<{n: number}>("SELECT n FROM value").get()!.n, 7); assert.equal(db.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title, "native retained");} finally {db.close();}
  }});
  await writeFile(path.join(f.root, "job-completed.json"), JSON.stringify({outcome}));
  // Keep the adopted lease alive so the fixture can also prove crash release.
  await poll(() => exists(path.join(f.root, "worker-exit")));
 } finally {access.close();}
}
async function parent() {
 const root = await realpath(await mkdtemp("/tmp/har-native-transfer-")), workspace = path.join(root, "workspace"), userData = path.join(root, "profile");
 let child: ReturnType<typeof spawn> | undefined;
 try {
  await mkdir(workspace); await mkdir(userData, {mode: 0o700});
  const application = path.join(root, "Harness.app"), candidate = path.join(root, "Next.app");
  for (const [bundle, version] of [[application, "1.0.0"], [candidate, "1.1.0"]]) {await mkdir(bundle!); await writeFile(path.join(bundle!, "version"), version!);}
  const config = resolveHarnessConfig({workspace, provider: "openai", storeBackend: "sqlite"}), databasePath = path.join(config.stateDirectory, HARNESS_SQLITE_FILE);
  const persistence = await openHarnessPersistence(config); persistence.close();
  const sessions = await openCliSessionStore({workspace, stateDirectory: config.stateDirectory, scope: config.scope}); await sessions.create({title: "native retained"}); sessions.close();
  const initial = new SqliteDatabase(databasePath); initial.exec("CREATE TABLE value(n INTEGER); INSERT INTO value VALUES(7)"); initial.close();
  const missingStateFd = process.argv[3] === "missing-state-fd";
  const fixture = path.join(root, "fixture.json"); await writeFile(fixture, JSON.stringify({root, workspace, userData, databasePath, application, candidate, missingStateFd, helper: await realpath(process.argv[2]!)}), {mode: 0o600});
  child = spawn(process.execPath, [process.argv[1]!, "host", fixture], {stdio: "ignore", env: {PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1"}});
  const exited = new Promise<number | null>((resolve, reject) => {child!.once("exit", resolve); child!.once("error", reject);});
  if (missingStateFd) {
   assert.notEqual(await exited, 0); assert.equal(await exists(path.join(root, "host-ready")), false);
   assert.equal(await readFile(path.join(application, "version"), "utf8"), "1.0.0"); await assert.rejects(checkDesktopStateFormat(userData));
   const db = new SqliteDatabase(databasePath); try {assert.equal(db.query<{n: number}>("SELECT n FROM value").get()!.n, 7);} finally {db.close();}
   const evidence = await mkdtemp("/tmp/har-transfer-rejection-report-");
   const report = {node: process.versions.node, electron: process.versions.electron, missingDescriptorRejectedBeforeAcknowledgement: true, applicationAndStateUnchanged: true, recoveryRemainsArmed: true, pass: true};
   await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report})); return;
  }
  await poll(() => exists(path.join(root, "host-ready")));
  const backup = JSON.parse(await readFile(path.join(root, "backup.json"), "utf8")); assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  const receipt = JSON.parse(await readFile(path.join(userData, "update-recovery", backup.id, "receipt.json"), "utf8"));
  const copy = new SqliteDatabase(path.join(userData, "update-recovery", backup.id, receipt.databases[0].backup.directory, HARNESS_SQLITE_FILE), {readonly: true});
  try {assert.equal(copy.query<{n: number}>("SELECT n FROM value").get()!.n, 7); assert.equal(copy.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title, "native retained");} finally {copy.close();}
  assert.throws(() => new SqliteDatabase(databasePath), /SQLITE_ACCESS_UNAVAILABLE/);
  await writeFile(path.join(root, "host-release"), ""); assert.equal(await exited, 0);
  assert.throws(() => new SqliteDatabase(databasePath), /SQLITE_ACCESS_UNAVAILABLE/);
  await writeFile(path.join(root, "worker-release"), ""); await poll(() => exists(path.join(root, "job-completed.json")));
  assert.equal(JSON.parse(await readFile(path.join(root, "job-completed.json"), "utf8")).outcome, "installed");
  assert.equal(await readFile(path.join(application, "version"), "utf8"), "1.1.0");
  assert.throws(() => new SqliteDatabase(databasePath), /SQLITE_ACCESS_UNAVAILABLE/);
  const {pid} = JSON.parse(await readFile(path.join(root, "spawn.json"), "utf8")); process.kill(pid, 0); process.kill(pid, "SIGKILL");
  await poll(async () => {try {process.kill(pid, 0); return false;} catch {return true;}});
  const reopened = new SqliteDatabase(databasePath); try {assert.equal(reopened.query<{n: number}>("SELECT n FROM value").get()!.n, 7);} finally {reopened.close();}
  const evidence = await mkdtemp("/tmp/har-transfer-report-");
  const report = {node: process.versions.node, electron: process.versions.electron, exclusiveBackupPrepared: true, snapshotRecordsVerified: true, receiptBoundHandoff: true, durableJobCompleted: true, liveStateReadOnlyVerified: true, incompatibleSchemaRejectedWithoutMigration: true, fixtureBundleVerifier: true, exclusiveBeforeHostExit: true, exclusiveAfterHostExit: true, inheritedLeaseUsedByWorker: true, workerCrashReleasesLease: true, contentsPreserved: true, pass: true};
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report}));
 } finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {const {pid} = JSON.parse(await readFile(path.join(root, "spawn.json"), "utf8")); process.kill(-pid, "SIGKILL");} catch {}
  await rm(root, {recursive: true, force: true});
 }
}
void (process.argv[2] === "host" ? host() : process.argv[2] === "worker" ? worker() : parent()).catch(() => {console.error("NATIVE_SQLITE_TRANSFER_FAILED"); process.exitCode = 1;});
