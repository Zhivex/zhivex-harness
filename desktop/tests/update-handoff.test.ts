import {expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import {mkdtemp, mkdir, realpath, rm, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {prepareDesktopStateTransaction, armDesktopStateTransaction} from "../src/state-transaction.js";
import {prepareDesktopUpdateJob, inspectDesktopUpdateJob} from "../src/update-job.js";
import {prepareDesktopUpdateHandoff, acknowledgeDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement, assertDesktopUpdateOwnersStopped, waitForDesktopUpdateOwners} from "../src/update-handoff.js";
import {resolveHarnessConfig} from "../../src/config.js";
import {acquireSqliteAccess} from "../../src/sqlite-access.js";
import {HARNESS_SQLITE_FILE} from "../../src/operations.js";
async function setup(withDatabases = false) {
 const userData = await realpath(await mkdtemp("/tmp/har-handoff-"));
 const configs = [];
 if (withDatabases) for (let i = 0; i < 2; i++) {const workspace = path.join(userData, `workspace${i}`), stateDirectory = path.join(userData, `state${i}`); await mkdir(workspace); await mkdir(stateDirectory, {mode: 0o700}); configs.push(resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"}));}
 const state = await prepareDesktopStateTransaction(userData, configs); await armDesktopStateTransaction(userData, state);
 const access = configs.map(c => {const databasePath = path.join(c.stateDirectory, HARNESS_SQLITE_FILE); return {databasePath, lease: acquireSqliteAccess(databasePath, true)!};});
 const job = await prepareDesktopUpdateJob(userData, state, {id: randomUUID(), application: path.join(userData, "Fixture.app")});
 const handoff = await prepareDesktopUpdateHandoff(job, [], access), directory = path.join(userData, "update-jobs", job.id), request = path.join(directory, `handoff-${handoff.nonce}.json`), ack = request.replace(/\.json$/, ".ack.json");
 return {userData, job, handoff, directory, request, ack, access};
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, withDatabases = false) {const f = await setup(withDatabases); try {await run(f);} finally {f.access.forEach(a => a.lease.close()); await rm(f.userData, {recursive: true, force: true});}}
test("handoff records main as an owner and never authorizes replacement while it lives", () => fixture(async f => {
 const request = JSON.parse(await readFile(f.request, "utf8")); expect(request.owners).toEqual([process.pid]);
 await expect(assertDesktopUpdateOwnersStopped(f.handoff)).rejects.toThrow("UPDATE_OWNERS_NOT_STOPPED");
 await expect(waitForDesktopUpdateOwners(f.handoff, {timeoutMs: 5})).rejects.toThrow("UPDATE_OWNERS_NOT_STOPPED");
 expect(() => process.kill(process.pid, 0)).not.toThrow();
 await expect(acknowledgeDesktopUpdateHandoff(f.handoff)).rejects.toThrow("UPDATE_HANDOFF_ACK_FAILED");
}));
test("spawn without acknowledgement times out without clearing recovery or accepting a live PID as ready", () => fixture(async f => {
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid, {timeoutMs: 5})).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
 expect(JSON.parse(await readFile(path.join(f.userData, "update-recovery/active.json"), "utf8")).id).toBeDefined();
}));
test("stale acknowledgement from another attempt is rejected", () => fixture(async f => {
 const value = JSON.parse(await readFile(f.request, "utf8"));
 await writeFile(f.ack, JSON.stringify({schemaVersion: 1, nonce: randomUUID(), jobId: value.jobId, digest: value.digest, requestSha256: f.handoff.sha256, workerPid: process.pid}), {mode: 0o600});
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid)).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
}));
test.skipIf(process.platform !== "darwin")("handoff requires every receipt database once with exclusive access", () => fixture(async f => {
 const request = JSON.parse(await readFile(f.request, "utf8"));
 expect(request.stateAccess.map((e: {descriptor: number}) => e.descriptor)).toEqual([4, 5]);
 expect(request.stateAccess.map((e: {databasePath: string}) => e.databasePath)).toEqual(f.access.map(e => e.databasePath));
 await expect(prepareDesktopUpdateHandoff(f.job, [], f.access.slice(1))).rejects.toThrow("UPDATE_HANDOFF_PREPARE_FAILED");
 await expect(prepareDesktopUpdateHandoff(f.job, [], [f.access[0]!, f.access[0]!])).rejects.toThrow("UPDATE_HANDOFF_PREPARE_FAILED");
 f.access[0]!.lease.close(); f.access[0]!.lease = acquireSqliteAccess(f.access[0]!.databasePath)!;
 await expect(prepareDesktopUpdateHandoff(f.job, [], f.access)).rejects.toThrow("UPDATE_HANDOFF_PREPARE_FAILED");
}, true));
test("the immutable request hash binds owners as well as the job and descriptor map", () => fixture(async f => {
 const request = JSON.parse(await readFile(f.request, "utf8")); request.owners = [2147483647];
 await writeFile(f.request, JSON.stringify(request));
 await expect(assertDesktopUpdateOwnersStopped(f.handoff)).rejects.toThrow("UPDATE_OWNERS_NOT_STOPPED");
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid, {timeoutMs: 5})).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
}));
test("job identity is stable across durable phases but a changed receipt invalidates the handoff", () => fixture(async f => {
 const original = await inspectDesktopUpdateJob(f.job), filename = path.join(f.directory, "job.json"), journal = JSON.parse(await readFile(filename, "utf8"));
 journal.phase = "applying"; await writeFile(filename, JSON.stringify(journal));
 expect((await inspectDesktopUpdateJob(f.job)).digest).toBe(original.digest);
 journal.application.id = randomUUID(); await writeFile(filename, JSON.stringify(journal));
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid, {timeoutMs: 5})).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
}));
