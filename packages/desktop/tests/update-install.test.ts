import {expect, test} from "bun:test";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {createDesktopUpdateInstaller, prepareDownloadedApplication} from "../src/update-install.js";
import {verifyUpdateManifest} from "../src/update-manifest.js";
import {stageUpdateDownload} from "../src/update-download.js";
import {createApplicationSwapper} from "../src/application-swap.js";
import {prepareExclusiveDesktopUpdateState} from "../src/update-inventory.js";
import {armDesktopStateTransaction} from "../src/state-transaction.js";
import {prepareDesktopUpdateJob, findDesktopUpdateRecoveryJob, inspectDesktopUpdateJob} from "../src/update-job.js";
import {prepareDesktopUpdateHandoff} from "../src/update-handoff.js";
import {checkDesktopStateFormat} from "../src/state-format.js";

const nativeTest = process.platform === "darwin" ? test : test.skip;

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
 const f = await setup(); try {await run(f);} finally {await rm(f.root, {recursive: true, force: true});}
}
async function setup() {
 const root = await realpath(await mkdtemp("/tmp/update-install-")), userData = path.join(root, "profile"), application = path.join(root, "Harness.app");
 await mkdir(userData, {mode: 0o700}); await mkdir(application); await writeFile(path.join(application, "version"), "1.0.0");
 await checkDesktopStateFormat(userData);
 const bytes = Buffer.from("fixture disk image"), keys = generateKeyPairSync("ed25519");
 const payload = Buffer.from(JSON.stringify({schemaVersion: 1, product: "ai.zhivex.harness", platform: "darwin", arch: "arm64", version: "1.1.0", channel: "stable", publishedAt: Date.now()-1000, expiresAt: Date.now()+60000, state: {minReadable: 1, maxReadable: 1}, artifact: {url: "https://github.com/Zhivex/zhivex-harness/releases/download/v1.1.0/app.dmg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}}));
 const update = verifyUpdateManifest(JSON.stringify({payload: payload.toString("base64url"), signature: sign(null, payload, keys.privateKey).toString("base64url")}), {publicKey: keys.publicKey, currentVersion: "1.0.0", channel: "stable", stateSchema: 1});
 const download = await stageUpdateDownload(update, {directory: path.join(root, "downloads"), fetch: (async () => new Response(bytes)) as unknown as typeof fetch});
 const policy = {userData, application, teamId: "ABCDEFGHIJ", version: "1.0.0"};
 const commands: string[] = [];
 const swapper = createApplicationSwapper(async (app, p) => {if (await readFile(path.join(app, "version"), "utf8") !== p.version) throw new Error();});
 const command = async (_binary: string, args: string[]) => {
  commands.push(args[0]!);
  if (args[0] === "attach") {const mount = args[args.indexOf("-mountpoint")+1]!; await mkdir(path.join(mount, "Zhivex Harness.app")); await writeFile(path.join(mount, "Zhivex Harness.app/version"), "1.1.0");}
  else {await rm(path.join(args[1]!, "Zhivex Harness.app"), {recursive: true, force: true});}
 };
 return {root, userData, policy, prepared: {update, download}, commands, candidate: (prepared: Parameters<typeof prepareDownloadedApplication>[0], p: Parameters<typeof prepareDownloadedApplication>[1]) => prepareDownloadedApplication(prepared, p, {command, swapper})};
}
function lifecycle() {
 const log: string[] = []; let alive = true, blocked = false;
 const runtime = {isAlive: () => alive, controlClose: async (operation: "pause"|"resume") => {log.push(operation); return false;}, close: async () => {log.push("close"); alive = false;}};
 const host = {busy: () => false, block: (value: boolean) => {blocked = value; log.push(`block:${value}`);}, hosts: async () => [runtime], inventory: () => ({projects: [], tasks: []}), closeTransports: async () => {log.push("transports");}, clearHosts: () => {log.push("clear");}, reload: () => {log.push("reload");}, quit: () => {log.push("quit");}};
 return {log, host, runtime, blocked: () => blocked};
}
function services(f: Awaited<ReturnType<typeof setup>>, log: string[]) {
 return {
  candidate: f.candidate,
  worker: {prepare: async () => ({directory: "/fixture", worker: "/fixture/worker.cjs", executable: "/fixture/electron", helper: "/fixture/helper", sha256: "a".repeat(64)}), launch: async () => {log.push("launch"); return {pid: process.pid};}},
  backup: prepareExclusiveDesktopUpdateState, arm: armDesktopStateTransaction, job: prepareDesktopUpdateJob, handoff: prepareDesktopUpdateHandoff,
  acknowledge: async () => {log.push("ack");},
 };
}
nativeTest("download-to-handoff journals recovery before exiting and keeps application admission blocked", () => fixture(async f => {
 const life = lifecycle();
 await createDesktopUpdateInstaller(f.policy, life.host, services(f, life.log))(f.prepared);
 expect(f.commands).toEqual(["attach", "detach"]);
 expect(life.log).toEqual(["block:true", "pause", "close", "transports", "clear", "launch", "ack", "quit"]);
 expect(life.blocked()).toBe(true);
 const job = await findDesktopUpdateRecoveryJob(f.userData);
 expect((await inspectDesktopUpdateJob(job)).phase).toBe("prepared");
 await expect(checkDesktopStateFormat(f.userData)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 expect(await readFile(path.join(f.policy.application, "version"), "utf8")).toBe("1.0.0");
}));
test("active work resumes without mounting, backup or cancellation", () => fixture(async f => {
 const life = lifecycle(); life.runtime.controlClose = async operation => {life.log.push(operation); return operation === "pause";};
 await expect(createDesktopUpdateInstaller(f.policy, life.host, services(f, life.log))(f.prepared)).rejects.toThrow("work-active");
 expect(life.log).toEqual(["block:true", "pause", "resume", "block:false"]); expect(f.commands).toEqual([]);
 await checkDesktopStateFormat(f.userData);
}));
test("changed artifact is rejected before mounting and idle runtimes resume", () => fixture(async f => {
 await writeFile(f.prepared.download.artifact, "corrupt"); const life = lifecycle();
 await expect(createDesktopUpdateInstaller(f.policy, life.host, services(f, life.log))(f.prepared)).rejects.toThrow("install-failed");
 expect(f.commands).toEqual([]); expect(life.log).toEqual(["block:true", "pause", "resume", "block:false"]);
 await checkDesktopStateFormat(f.userData);
}));
nativeTest("failed worker acknowledgement preserves recovery and never exits or reopens admission", () => fixture(async f => {
 const life = lifecycle(); const deps = services(f, life.log); deps.acknowledge = async () => {throw new Error("fixture no ack");};
 await expect(createDesktopUpdateInstaller(f.policy, life.host, deps)(f.prepared)).rejects.toThrow("recovery-required");
 expect(life.blocked()).toBe(true); expect(life.log).not.toContain("quit"); expect(life.log).not.toContain("block:false");
 expect((await inspectDesktopUpdateJob(await findDesktopUpdateRecoveryJob(f.userData))).phase).toBe("prepared");
}));
test("backup failure after runtime closure reloads without arming recovery", () => fixture(async f => {
 const life = lifecycle(), deps = services(f, life.log); deps.backup = async () => {throw new Error("fixture backup failure");};
 await expect(createDesktopUpdateInstaller(f.policy, life.host, deps)(f.prepared)).rejects.toThrow("install-failed");
 expect(life.log).toContain("reload"); expect(life.blocked()).toBe(false); await checkDesktopStateFormat(f.userData);
}));

(process.platform !== "darwin" ? test : test.skip)("unsupported platforms refuse native handoff without arming recovery or quitting", () => fixture(async f => {
 const life = lifecycle();
 await expect(createDesktopUpdateInstaller(f.policy, life.host, services(f, life.log))(f.prepared)).rejects.toThrow("install-failed");
 expect(life.log).not.toContain("launch"); expect(life.log).not.toContain("quit");
 expect(life.log).toContain("reload"); expect(life.blocked()).toBe(false);
 await checkDesktopStateFormat(f.userData);
 expect(await readFile(path.join(f.policy.application, "version"), "utf8")).toBe("1.0.0");
}));
