import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {createApplicationSwapper} from "../src/application-swap.js";
async function fixture(run: (f: {root: string; application: string; candidate: string; input: {application: string; candidate: string; previousVersion: string; nextVersion: string; teamId: string}}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-app-swap-")), application = path.join(root, "Applications/Current.app"), candidate = path.join(root, "Download/Candidate.app");
 for (const [app, version] of [[application, "1.0.0"], [candidate, "1.1.0"]]) {await mkdir(path.join(app!, "Contents"), {recursive: true}); await writeFile(path.join(app!, "Contents/version"), version!);}
 try {await run({root, application, candidate, input: {application, candidate, previousVersion: "1.0.0", nextVersion: "1.1.0", teamId: "ABCDEFGHIJ"}});} finally {await rm(root, {recursive: true, force: true});}
}
const version = (app: string) => readFile(path.join(app, "Contents/version"), "utf8");
const verifier = async (app: string, policy: {version: string}) => {if (await version(app) !== policy.version) throw new Error("fixture version mismatch");};
const stopped = {assertStopped: async () => {}};
test("stages without touching current app, installs, and restores the previous bundle from disk", () => fixture(async f => {
 const swapper = createApplicationSwapper(verifier), swap = await swapper.prepare(f.input);
 expect(await version(f.application)).toBe("1.0.0");
 await swapper.activate(swap, stopped); expect(await version(f.application)).toBe("1.1.0");
 const directory = path.join(path.dirname(f.application), `.zhivex-update-${swap.id}`);
 expect(await version(path.join(directory, "previous.app"))).toBe("1.0.0");
 await createApplicationSwapper(verifier).rollback(swap, stopped); expect(await version(f.application)).toBe("1.0.0");
 expect((await readdir(directory)).some(n => n.startsWith("failed-"))).toBe(true);
 await swapper.rollback(swap, stopped); expect(await version(f.application)).toBe("1.0.0");
}));
test("failure after either swap rename recovers the original application without deleting a bundle", () => fixture(async f => {
 for (const step of [1, 2]) {
  const swapper = createApplicationSwapper(verifier), swap = await swapper.prepare(f.input);
  await expect(swapper.activate(swap, {...stopped, afterMove: async n => {if (n === step) throw new Error("fixture crash");}})).rejects.toThrow("UPDATE_APPLICATION_ACTIVATE_FAILED");
  await expect(swapper.activate(swap, stopped)).rejects.toThrow("UPDATE_APPLICATION_ACTIVATE_FAILED");
  await swapper.rollback(swap, stopped); expect(await version(f.application)).toBe("1.0.0");
  expect(await version(f.candidate)).toBe("1.1.0");
 }
}));
test("rollback can resume after each of its own rename boundaries", () => fixture(async f => {
 for (const step of [1, 2]) {
  const swapper = createApplicationSwapper(verifier), swap = await swapper.prepare(f.input); await swapper.activate(swap, stopped);
  await expect(swapper.rollback(swap, {...stopped, afterMove: async n => {if (n === step) throw new Error("fixture crash");}})).rejects.toThrow("UPDATE_APPLICATION_ROLLBACK_FAILED");
  await swapper.rollback(swap, stopped); expect(await version(f.application)).toBe("1.0.0");
 }
}));
test("live owner and changed staged bytes refuse activation before the current app moves", () => fixture(async f => {
 const swapper = createApplicationSwapper(verifier), swap = await swapper.prepare(f.input);
 await expect(swapper.activate(swap, {assertStopped: async () => {throw new Error("still running");}})).rejects.toThrow("UPDATE_APPLICATION_ACTIVATE_FAILED");
 expect(await version(f.application)).toBe("1.0.0");
 const staged = path.join(path.dirname(f.application), `.zhivex-update-${swap.id}`, "next.app"); await writeFile(path.join(staged, "Contents/version"), "tampered");
 await expect(swapper.activate(swap, stopped)).rejects.toThrow("UPDATE_APPLICATION_ACTIVATE_FAILED");
 expect(await version(f.application)).toBe("1.0.0");
}));
test("verification failure after replacement rolls back using the validated previous bundle", () => fixture(async f => {
 const verify = async (app: string, policy: {version: string}) => {await verifier(app, policy); if (app === f.application && policy.version === "1.1.0") throw new Error("post-install failure");};
 const swapper = createApplicationSwapper(verify), swap = await swapper.prepare(f.input);
 await expect(swapper.activate(swap, stopped)).rejects.toThrow("UPDATE_APPLICATION_ACTIVATE_FAILED");
 await swapper.rollback(swap, stopped); expect(await version(f.application)).toBe("1.0.0");
}));
test("external symlinks are rejected; framework-style internal links survive staging", () => fixture(async f => {
 await symlink("/tmp", path.join(f.candidate, "Contents/external"));
 await expect(createApplicationSwapper(verifier).prepare(f.input)).rejects.toThrow("UPDATE_APPLICATION_PREPARE_FAILED");
 await rm(path.join(f.candidate, "Contents/external")); await symlink("version", path.join(f.candidate, "Contents/current"));
 const swapper = createApplicationSwapper(verifier), swap = await swapper.prepare(f.input); await swapper.activate(swap, stopped);
 expect(await readFile(path.join(f.application, "Contents/current"), "utf8")).toBe("1.1.0");
}));
