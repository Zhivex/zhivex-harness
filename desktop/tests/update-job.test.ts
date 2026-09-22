import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {createApplicationSwapper} from "../src/application-swap.js";
import {armDesktopStateTransaction, prepareDesktopStateTransaction} from "../src/state-transaction.js";
import {checkDesktopStateFormat} from "../src/state-format.js";
import {executeDesktopUpdateJob, prepareDesktopUpdateJob, type DesktopUpdateOutcome} from "../src/update-job.js";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
 const f = await setup(); try {await run(f);} finally {await rm(f.root, {recursive: true, force: true});}
}
async function setup() {
 const root = await realpath(await mkdtemp("/tmp/har-update-job-")), userData = path.join(root, "profile"), application = path.join(root, "Harness.app"), candidate = path.join(root, "Next.app");
 await mkdir(userData, {mode: 0o700}); await mkdir(path.join(userData, "projects"), {mode: 0o700});
 const index = path.join(userData, "projects/projects.json"); await writeFile(index, "original", {mode: 0o600});
 for (const [bundle, version] of [[application, "1.0.0"], [candidate, "1.1.0"]]) {await mkdir(bundle!); await writeFile(path.join(bundle!, "version"), version!);}
 const swapper = createApplicationSwapper(async (bundle, policy) => {if (await readFile(path.join(bundle, "version"), "utf8") !== policy.version) throw new Error("fixture signature");});
 const swap = await swapper.prepare({application, candidate, teamId: "ABCDEFGHIJ", previousVersion: "1.0.0", nextVersion: "1.1.0"});
 const state = await prepareDesktopStateTransaction(userData, []); await armDesktopStateTransaction(userData, state);
 const job = await prepareDesktopUpdateJob(userData, state, swap);
 const journal = path.join(userData, "update-jobs", job.id, "job.json");
 const deps = {swapper, assertStopped: async () => {}, verifyState: async (_outcome: DesktopUpdateOutcome) => {if (await readFile(index, "utf8") !== "original") throw new Error("fixture state invalid");}};
 return {root, userData, application, index, swapper, swap, state, job, journal, deps};
}
const interrupted = async () => {throw new Error("fixture process interruption");};
test("persistent job installs and confirms both application and state before removing recovery gate", () => fixture(async f => {
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow();
 expect(await executeDesktopUpdateJob(f.job, f.deps)).toBe("installed");
 await checkDesktopStateFormat(f.userData);
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.1.0");
 expect(JSON.parse(await readFile(f.journal, "utf8")).phase).toBe("completed");
 expect(await executeDesktopUpdateJob(f.job, {...f.deps, assertStopped: interrupted})).toBe("installed");
}));
test("restart in applying recovers an interrupted bundle rename and the matching metadata backup", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, afterPersist: async phase => {if (phase === "applying") await interrupted();}})).rejects.toThrow();
 await expect(f.swapper.activate(f.swap, {assertStopped: async () => {}, afterMove: interrupted})).rejects.toThrow();
 await writeFile(f.index, "migration changed state");
 expect(await executeDesktopUpdateJob(f.job, f.deps)).toBe("restored");
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.0.0");
 expect(await readFile(f.index, "utf8")).toBe("original"); await checkDesktopStateFormat(f.userData);
}));
test("a failed state verification durably chooses recovery, which resumes after process interruption", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps,
  verifyState: async outcome => {if (outcome === "installed") {await writeFile(f.index, "partial migration"); throw new Error("migration failed");} await f.deps.verifyState(outcome);},
  afterPersist: async phase => {if (phase === "recovering") await interrupted();},
 })).rejects.toThrow();
 expect(JSON.parse(await readFile(f.journal, "utf8")).phase).toBe("recovering");
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow();
 expect(await executeDesktopUpdateJob(f.job, f.deps)).toBe("restored");
 expect(await readFile(f.index, "utf8")).toBe("original");
}));
test("lost completion acknowledgement never restores over work accepted after the state gate cleared", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, afterStateFinished: interrupted})).rejects.toThrow();
 expect(JSON.parse(await readFile(f.journal, "utf8")).phase).toBe("finishing"); await checkDesktopStateFormat(f.userData);
 await writeFile(f.index, "new user work");
 let ownersChecked = false;
 expect(await executeDesktopUpdateJob(f.job, {...f.deps,
  assertStopped: async () => {ownersChecked = true; throw new Error("app is open again");},
  verifyState: async () => {expect(await readFile(f.index, "utf8")).toBe("new user work");},
 })).toBe("installed");
 expect(ownersChecked).toBe(false); expect(await readFile(f.index, "utf8")).toBe("new user work");
}));
test("finishing failures retain the chosen outcome and never attempt rollback", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, afterPersist: async phase => {if (phase === "finishing") await interrupted();}})).rejects.toThrow();
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, verifyState: interrupted})).rejects.toThrow("UPDATE_JOB_CONFIRMATION_REQUIRED");
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.1.0");
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow();
 expect(await executeDesktopUpdateJob(f.job, f.deps)).toBe("installed");
}));
test("wrong state receipt and live owners prevent installation without changing application or state", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, assertStopped: interrupted})).rejects.toThrow();
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.0.0");
 const pointer = path.join(f.userData, "update-recovery/active.json");
 await writeFile(pointer, JSON.stringify({schemaVersion: 1, id: crypto.randomUUID(), sha256: f.state.sha256}));
 await expect(executeDesktopUpdateJob(f.job, f.deps)).rejects.toThrow("DESKTOP_STATE_TRANSACTION_MISMATCH");
 expect(await readFile(f.index, "utf8")).toBe("original");
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.0.0");
}));
test("missing format marker after a lost acknowledgement is rejected without initializing state", () => fixture(async f => {
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, afterStateFinished: interrupted})).rejects.toThrow();
 const marker = path.join(f.userData, "state-compatibility/format.json"); await rm(marker);
 await expect(executeDesktopUpdateJob(f.job, f.deps)).rejects.toThrow("UPDATE_JOB_CONFIRMATION_REQUIRED");
 await expect(readFile(marker)).rejects.toThrow();
 expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.1.0");
}));
test("invalid durable phase/outcome is refused before callbacks or filesystem effects", () => fixture(async f => {
 const journal = JSON.parse(await readFile(f.journal, "utf8")); journal.phase = "finishing"; journal.outcome = null;
 await writeFile(f.journal, JSON.stringify(journal));
 let called = false;
 await expect(executeDesktopUpdateJob(f.job, {...f.deps, assertStopped: async () => {called = true;}})).rejects.toThrow("UPDATE_JOB_INVALID");
 expect(called).toBe(false); expect(await readFile(path.join(f.application, "version"), "utf8")).toBe("1.0.0");
}));
test("pre-armed journal survives the recovery boundary and startup selects only its pinned receipt", () => fixture(async f => {
 const {findDesktopUpdateRecoveryJob} = await import("../src/update-job.js");
 const profile = path.join(f.root, "pre-arm"); await mkdir(profile, {mode: 0o700});
 const state = await prepareDesktopStateTransaction(profile, []);
 await expect(prepareDesktopUpdateJob(profile, state, f.swap)).rejects.toThrow("UPDATE_JOB_PREPARE_FAILED");
 const job = await prepareDesktopUpdateJob(profile, state, f.swap, {allowUnarmed: true});
 await expect(findDesktopUpdateRecoveryJob(profile)).rejects.toThrow();
 await expect(executeDesktopUpdateJob(job, f.deps)).rejects.toThrow("UPDATE_JOB_STATE_MISSING");
 await armDesktopStateTransaction(profile, state);
 expect(await findDesktopUpdateRecoveryJob(profile)).toEqual(job);
 await prepareDesktopUpdateJob(profile, state, f.swap);
 await expect(findDesktopUpdateRecoveryJob(profile)).rejects.toThrow("UPDATE_RECOVERY_JOB_INVALID");
}));
test("restart rejects a completed job whose application has not passed the native publisher policy", () => fixture(async f => {
 const {reopenCompletedDesktopUpdate} = await import("../src/update-recovery.js");
 await executeDesktopUpdateJob(f.job, f.deps);
 await expect(reopenCompletedDesktopUpdate(f.job)).rejects.toThrow("UPDATE_APPLICATION_OUTCOME_INVALID");
}));
