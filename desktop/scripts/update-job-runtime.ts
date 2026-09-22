import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile, access} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../../src/runtime/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/persistence/operations.js";
import {openCliSessionStore} from "../../src/persistence/sessions.js";
import {SqliteDatabase} from "../../src/persistence/sqlite-database.js";
import {createApplicationSwapper} from "../src/application-swap.js";
import {armDesktopStateTransaction, prepareDesktopStateTransaction} from "../src/state-transaction.js";
import {checkDesktopStateFormat} from "../src/state-format.js";
import {executeDesktopUpdateJob, prepareDesktopUpdateJob} from "../src/update-job.js";
import {launchDesktopUpdateWorker} from "../src/update-worker-launcher.js";
import type {DesktopBackupConfig} from "../src/database-backup.js";

const swapper = createApplicationSwapper(async (bundle, policy) => {assert.equal(await readFile(path.join(bundle, "version"), "utf8"), policy.version);});
const configFor = (root: string, i: number) => resolveHarnessConfig({workspace: path.join(root, `repo${i}`), stateDirectory: path.join(root, `state${i}`), storeBackend: "sqlite", provider: "openai"});
async function poll(check: () => Promise<boolean>) {
 const deadline = Date.now() + 8000;
 while (Date.now() < deadline) {if (await check()) return; await new Promise(r => setTimeout(r, 25));}
 throw new Error("FIXTURE_TIMEOUT");
}
const exists = (file: string) => access(file).then(() => true, () => false);
async function worker() {
 const filename = process.argv[3]!, f = JSON.parse(await readFile(filename, "utf8"));
 const outcome = await executeDesktopUpdateJob(f.job, {swapper, assertStopped: async () => {},
  verifyState: async outcome => {
   if (outcome === "installed") {
    for (let i = 0; i < 2; i++) {const db = new SqliteDatabase(path.join(configFor(f.root, i).stateDirectory, HARNESS_SQLITE_FILE)); try {db.exec("UPDATE zhivex_cli_sessions SET title='partial migration'");} finally {db.close();}}
    await writeFile(f.index, "partial metadata migration"); throw new Error("fixture migration failure");
   }
   for (let i = 0; i < 2; i++) {const db = new SqliteDatabase(path.join(configFor(f.root, i).stateDirectory, HARNESS_SQLITE_FILE), {readonly: true}); try {assert.equal(db.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title, `original ${i}`);} finally {db.close();}}
   assert.equal(await readFile(f.index, "utf8"), "original");
  },
  afterPersist: async phase => {
   if (phase === "recovering" && process.argv[4] === "interrupt") {
    await writeFile(path.join(f.root, "ready-to-kill"), String(process.pid));
    await new Promise<void>(() => {setInterval(() => {}, 1000);});
   }
  },
 });
 await writeFile(path.join(f.root, "done.json"), JSON.stringify({outcome, pid: process.pid}));
}
async function parent() {
 const root = await realpath(await mkdtemp("/tmp/har-native-job-")), userData = path.join(root, "profile"), pids: number[] = [];
 try {
  await mkdir(userData, {mode: 0o700}); const configs: DesktopBackupConfig[] = [];
  for (let i = 0; i < 2; i++) {
   const config = configFor(root, i); await mkdir(config.workspace); await mkdir(config.stateDirectory, {mode: 0o700});
   const persistence = await openHarnessPersistence(config); persistence.close();
   const sessions = await openCliSessionStore({workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope});
   await sessions.create({title: `original ${i}`}); sessions.close(); configs.push(config);
  }
  await rm(configs[1]!.workspace, {recursive: true}); configs[1] = {...configs[1]!, workspaceAbsent: true};
  await mkdir(path.join(userData, "projects"), {mode: 0o700}); const index = path.join(userData, "projects/projects.json"); await writeFile(index, "original", {mode: 0o600});
  const application = path.join(root, "Harness.app"), candidate = path.join(root, "Next.app");
  for (const [bundle, version] of [[application, "1.0.0"], [candidate, "1.1.0"]]) {await mkdir(bundle!); await writeFile(path.join(bundle!, "version"), version!);}
  const swap = await swapper.prepare({application, candidate, teamId: "ABCDEFGHIJ", previousVersion: "1.0.0", nextVersion: "1.1.0"});
  const state = await prepareDesktopStateTransaction(userData, configs); await armDesktopStateTransaction(userData, state);
  const job = await prepareDesktopUpdateJob(userData, state, swap), filename = path.join(root, "fixture.json");
  await writeFile(filename, JSON.stringify({root, index, job}), {mode: 0o600});
  const workerFile = await realpath(process.argv[1]!);
  const launch = (mode: string) => launchDesktopUpdateWorker({directory: path.dirname(workerFile), worker: workerFile, helper: process.argv[2]!, executable: process.execPath, arguments: ["worker", filename, mode]});
  const first = await launch("interrupt"); pids.push(first.pid);
  await poll(() => exists(path.join(root, "ready-to-kill"))); assert.equal(Number(await readFile(path.join(root, "ready-to-kill"), "utf8")), first.pid);
  await assert.rejects(checkDesktopStateFormat(userData));
  process.kill(first.pid, "SIGKILL");
  await poll(async () => {try {process.kill(first.pid, 0); return false;} catch {return true;}});
  const second = await launch("resume"); pids.push(second.pid); await poll(() => exists(path.join(root, "done.json")));
  assert.equal(JSON.parse(await readFile(path.join(root, "done.json"), "utf8")).outcome, "restored");
  await checkDesktopStateFormat(userData); assert.equal(await readFile(path.join(application, "version"), "utf8"), "1.0.0");
  await assert.rejects(realpath(configs[1]!.workspace));
  const evidence = await mkdtemp("/tmp/har-update-job-report-");
  const report = {node: process.versions.node, electron: process.versions.electron, databases: 2, archivedWorkspaceRestoredWithoutCheckout: true, nativeWorkerKilled: true, recoveryInNewProcess: true, appAndStateRestored: true, fixtureBundleVerifier: true, pass: true};
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report}));
 } finally {for (const pid of pids) {try {process.kill(-pid, "SIGKILL");} catch {}} await rm(root, {recursive: true, force: true});}
}
void (process.argv[2] === "worker" ? worker() : parent()).catch(() => {console.error("NATIVE_UPDATE_JOB_FAILED"); process.exitCode = 1;});
