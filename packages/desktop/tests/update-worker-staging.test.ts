import {expect, test} from "bun:test";
import {chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {createDesktopUpdateWorkerStager} from "../src/update-worker-staging.js";
async function fixture(run: (f: {root: string; application: string; userData: string; source: string; teamId: string; version: string}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-worker-stage-")), application = path.join(root, "Fixture.app"), userData = path.join(root, "profile");
 const source = path.join(application, "Contents/Resources/update-worker-entry.cjs");
 await mkdir(path.dirname(source), {recursive: true}); await mkdir(userData, {mode: 0o700}); await writeFile(source, "process.exit(0);", {mode: 0o644});
 try {await run({root, application, userData, source, teamId: "ABCDEFGHIJ", version: "1.0.0"});} finally {await rm(root, {recursive: true, force: true});}
}
test("stages verified bytes privately outside the app and reuses the immutable path", () => fixture(async f => {
 let verified = 0; const stager = createDesktopUpdateWorkerStager(async () => {verified++;});
 const first = await stager.prepare(f), second = await stager.prepare(f);
 expect(verified).toBe(4); expect(first.worker).toBe(second.worker); expect(Object.isFrozen(first)).toBe(true);
 expect(first.worker.startsWith(f.userData + path.sep)).toBe(true); expect(await readFile(first.worker, "utf8")).toBe("process.exit(0);");
 expect(await readdir(first.directory)).toEqual([path.basename(first.worker)]);
 await rm(f.application, {recursive: true}); expect(await readFile(first.worker, "utf8")).toBe("process.exit(0);");
}));
test("signature rejection and resource changes during verification publish no worker", () => fixture(async f => {
 await expect(createDesktopUpdateWorkerStager(async () => {throw new Error();}).prepare(f)).rejects.toThrow("UPDATE_WORKER_STAGING_FAILED");
 expect(await readdir(f.userData)).toEqual([]);
 let calls = 0; const stager = createDesktopUpdateWorkerStager(async () => {if (++calls === 2) await writeFile(f.source, "changed");});
 await expect(stager.prepare(f)).rejects.toThrow("UPDATE_WORKER_STAGING_FAILED"); expect(await readdir(f.userData)).toEqual([]);
}));
test("public staging and symlinked source refuse preparation", () => fixture(async f => {
 const stager = createDesktopUpdateWorkerStager(async () => {}), directory = path.join(f.userData, "update-worker");
 await mkdir(directory, {mode: 0o755}); await chmod(directory, 0o755);
 await expect(stager.prepare(f)).rejects.toThrow("UPDATE_WORKER_STAGING_FAILED"); expect(await readdir(directory)).toEqual([]);
 await rm(f.source); const target = path.join(f.root, "outside.cjs"); await writeFile(target, "outside"); await symlink(target, f.source);
 await expect(stager.prepare(f)).rejects.toThrow("UPDATE_WORKER_STAGING_FAILED");
}));
test("changed staged bytes and fabricated handles cannot be launched", () => fixture(async f => {
 const stager = createDesktopUpdateWorkerStager(async () => {}), worker = await stager.prepare(f);
 const handoff = {job: {userData: f.userData, id: "unused"}, nonce: "unused", sha256: "0".repeat(64)};
 await expect(stager.launch({...worker}, handoff, [])).rejects.toThrow("UPDATE_WORKER_STAGING_LAUNCH_FAILED");
 await writeFile(worker.worker, "changed");
 await expect(stager.launch(worker, handoff, [])).rejects.toThrow("UPDATE_WORKER_STAGING_LAUNCH_FAILED");
 await expect(stager.prepare(f)).rejects.toThrow("UPDATE_WORKER_STAGING_FAILED");
 expect(await readFile(worker.worker, "utf8")).toBe("changed");
}));
