import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {prepareDesktopStateTransaction, armDesktopStateTransaction} from "../src/state-transaction.js";
import {prepareDesktopUpdateJob, executeDesktopUpdateJob} from "../src/update-job.js";
import {createApplicationSwapper} from "../src/application-swap.js";
import {launchDesktopUpdateWorker} from "../src/update-worker-launcher.js";
import {prepareDesktopUpdateHandoff, acknowledgeDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement, waitForDesktopUpdateOwners, assertDesktopUpdateOwnersStopped} from "../src/update-handoff.js";
const exists = (file: string) => access(file).then(() => true, () => false);
async function poll(check: () => Promise<boolean>) {const deadline = Date.now() + 8000; while (Date.now() < deadline) {if (await check()) return; await new Promise(r => setTimeout(r, 25));} throw new Error("FIXTURE_TIMEOUT");}
const swapper = createApplicationSwapper(async (bundle, policy) => {assert.equal(await readFile(path.join(bundle, "version"), "utf8"), policy.version);});
async function host() {
 const filename = process.argv[3]!, f = JSON.parse(await readFile(filename, "utf8")), workerFile = await realpath(process.argv[1]!);
 const handoff = await prepareDesktopUpdateHandoff(f.job, []);
 const worker = await launchDesktopUpdateWorker({directory: path.dirname(workerFile), worker: workerFile, helper: f.helper, executable: process.execPath, arguments: ["worker", filename, handoff.nonce, handoff.sha256]});
 await writeFile(path.join(f.root, "spawn.json"), JSON.stringify(worker));
 await waitForDesktopUpdateAcknowledgement(handoff, worker.pid);
 await writeFile(path.join(f.root, "acknowledged.json"), JSON.stringify({hostPid: process.pid, workerPid: worker.pid}));
 // The outer fixture holds the host here, then lets it exit naturally.
 await poll(() => exists(path.join(f.root, "exit-host")));
}
async function worker() {
 const f = JSON.parse(await readFile(process.argv[3]!, "utf8")), handoff = {job: f.job, nonce: process.argv[4]!, sha256: process.argv[5]!};
 await acknowledgeDesktopUpdateHandoff(handoff);
 await waitForDesktopUpdateOwners(handoff, {timeoutMs: 10000});
 const outcome = await executeDesktopUpdateJob(f.job, {swapper, assertStopped: () => assertDesktopUpdateOwnersStopped(handoff), verifyState: async () => {}});
 await writeFile(path.join(f.root, "done.json"), JSON.stringify({pid: process.pid, outcome}));
}
async function parent() {
 const root = await realpath(await mkdtemp("/tmp/har-native-handoff-")), userData = path.join(root, "profile");
 let child: ReturnType<typeof spawn> | undefined;
 try {
  await mkdir(userData, {mode: 0o700});
  const application = path.join(root, "Harness.app"), candidate = path.join(root, "Next.app");
  for (const [bundle, version] of [[application, "1.0.0"], [candidate, "1.1.0"]]) {await mkdir(bundle!); await writeFile(path.join(bundle!, "version"), version!);}
  const swap = await swapper.prepare({application, candidate, teamId: "ABCDEFGHIJ", previousVersion: "1.0.0", nextVersion: "1.1.0"});
  const state = await prepareDesktopStateTransaction(userData, []); await armDesktopStateTransaction(userData, state);
  const job = await prepareDesktopUpdateJob(userData, state, swap), filename = path.join(root, "fixture.json");
  await writeFile(filename, JSON.stringify({root, job, helper: await realpath(process.argv[2]!)}), {mode: 0o600});
  child = spawn(process.execPath, [await realpath(process.argv[1]!), "host", filename], {stdio: "ignore", env: {PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1"}});
  const exited = new Promise<number | null>((resolve, reject) => {child!.once("exit", resolve); child!.once("error", reject);});
  await poll(() => exists(path.join(root, "acknowledged.json")));
  const ack = JSON.parse(await readFile(path.join(root, "acknowledged.json"), "utf8"));
  assert.equal(ack.hostPid, child.pid); process.kill(ack.hostPid, 0); process.kill(ack.workerPid, 0);
  assert.equal(await exists(path.join(root, "done.json")), false);
  assert.equal(await readFile(path.join(application, "version"), "utf8"), "1.0.0");
  await writeFile(path.join(root, "exit-host"), ""); assert.equal(await exited, 0);
  await poll(() => exists(path.join(root, "done.json")));
  const done = JSON.parse(await readFile(path.join(root, "done.json"), "utf8")); assert.equal(done.pid, ack.workerPid); assert.equal(done.outcome, "installed");
  assert.equal(await readFile(path.join(application, "version"), "utf8"), "1.1.0");
  const evidence = await mkdtemp("/tmp/har-handoff-report-");
  const report = {node: process.versions.node, electron: process.versions.electron, durableAcknowledgement: true, replacementBlockedWhileHostLives: true, sameWorkerCompletedAfterHostExit: true, fixtureBundleVerifier: true, pass: true};
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report}));
 } finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {const {pid} = JSON.parse(await readFile(path.join(root, "spawn.json"), "utf8")); process.kill(-pid, "SIGKILL");} catch {}
  await rm(root, {recursive: true, force: true});
 }
}
void (process.argv[2] === "host" ? host() : process.argv[2] === "worker" ? worker() : parent()).catch(() => {console.error("NATIVE_HANDOFF_FAILED"); process.exitCode = 1;});
