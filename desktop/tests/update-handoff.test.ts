import {expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import {mkdtemp, realpath, rm, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {prepareDesktopStateTransaction, armDesktopStateTransaction} from "../src/state-transaction.js";
import {prepareDesktopUpdateJob, inspectDesktopUpdateJob} from "../src/update-job.js";
import {prepareDesktopUpdateHandoff, acknowledgeDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement, assertDesktopUpdateOwnersStopped, waitForDesktopUpdateOwners} from "../src/update-handoff.js";
async function setup() {
 const userData = await realpath(await mkdtemp("/tmp/har-handoff-"));
 const state = await prepareDesktopStateTransaction(userData, []); await armDesktopStateTransaction(userData, state);
 const job = await prepareDesktopUpdateJob(userData, state, {id: randomUUID(), application: path.join(userData, "Fixture.app")});
 const handoff = await prepareDesktopUpdateHandoff(job, []), directory = path.join(userData, "update-jobs", job.id), request = path.join(directory, `handoff-${handoff.nonce}.json`), ack = request.replace(/\.json$/, ".ack.json");
 return {userData, job, handoff, directory, request, ack};
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {const f = await setup(); try {await run(f);} finally {await rm(f.userData, {recursive: true, force: true});}}
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
 await writeFile(f.ack, JSON.stringify({schemaVersion: 1, nonce: randomUUID(), jobId: value.jobId, digest: value.digest, workerPid: process.pid}), {mode: 0o600});
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid)).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
}));
test("job identity is stable across durable phases but a changed receipt invalidates the handoff", () => fixture(async f => {
 const original = await inspectDesktopUpdateJob(f.job), filename = path.join(f.directory, "job.json"), journal = JSON.parse(await readFile(filename, "utf8"));
 journal.phase = "applying"; await writeFile(filename, JSON.stringify(journal));
 expect((await inspectDesktopUpdateJob(f.job)).digest).toBe(original.digest);
 journal.application.id = randomUUID(); await writeFile(filename, JSON.stringify(journal));
 await expect(waitForDesktopUpdateAcknowledgement(f.handoff, process.pid, {timeoutMs: 5})).rejects.toThrow("UPDATE_HANDOFF_UNCONFIRMED");
}));
