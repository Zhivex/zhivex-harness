import {expect, test, beforeAll, afterAll} from "bun:test";
import {chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {launchDesktopUpdateWorker} from "../src/update-worker-launcher.js";
import {acquireSqliteAccess} from "../../src/persistence/sqlite-access.js";

const nativeTest = process.platform === "darwin" ? test : test.skip;
const electron = path.resolve(import.meta.dir, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
let helperRoot: string, helper: string;
beforeAll(async () => {
 if (process.platform !== "darwin") return;
 helperRoot = await realpath(await mkdtemp("/tmp/har-worker-helper-")); helper = path.join(helperRoot, "update-worker-lock");
 const compiler = Bun.spawn(["/usr/bin/swiftc", "-target", "arm64-apple-macos13.0", "-module-cache-path", path.join(helperRoot, "cache"), path.resolve(import.meta.dir, "../native/UpdateWorkerLock.swift"), "-o", helper], {stdout: "ignore", stderr: "inherit"});
 if (await compiler.exited !== 0) throw new Error("fixture helper compilation failed");
}, 60000);
afterAll(async () => {if (helperRoot) await rm(helperRoot, {recursive: true, force: true});});
async function poll(check: () => Promise<boolean>) {
 const deadline = Date.now() + 8000;
 while (Date.now() < deadline) {if (await check()) return; await Bun.sleep(25);}
 throw new Error("fixture timed out");
}
async function exists(file: string) {return lstat(file).then(() => true, () => false);}
async function fixture(run: (f: {directory: string; worker: string; executable: string; helper: string; arguments: string[]}, groups: number[]) => Promise<void>) {
 const directory = await realpath(await mkdtemp("/tmp/har-update-worker-")), worker = path.join(directory, "worker.cjs"), groups: number[] = [];
 await writeFile(worker, `const fs=require('node:fs');const id=process.argv[2];
fs.writeFileSync(id+'.starting',JSON.stringify({pid:process.pid,keys:Object.keys(process.env),node:process.versions.node,electron:process.versions.electron}));
fs.renameSync(id+'.starting',id+'.started');
const timer=setInterval(()=>{if(fs.existsSync(id+'.release')){clearInterval(timer);process.exit(0)}},25);
setTimeout(()=>process.exit(2),20000).unref();`, {mode: 0o600});
 try {await run({directory, worker, executable: await realpath(electron), helper, arguments: []}, groups);}
 finally {for (const pid of groups) {try {process.kill(-pid, "SIGKILL");} catch {}} await rm(directory, {recursive: true, force: true});}
}
nativeTest("native worker outlives its launcher, excludes contenders and releases its persistent lock after exit", () => fixture(async (f, groups) => {
 const launcher = path.join(f.directory, "launcher.ts"), first = path.join(f.directory, "first"), second = path.join(f.directory, "second");
 const module = path.resolve(import.meta.dir, "../src/update-worker-launcher.ts");
 await writeFile(launcher, `import {launchDesktopUpdateWorker} from ${JSON.stringify(module)};
const result=await launchDesktopUpdateWorker(${JSON.stringify({...f, arguments: [first]})});
await Bun.write(${JSON.stringify(path.join(f.directory, "spawn.json"))},JSON.stringify(result));`);
 const parent = Bun.spawn([process.execPath, launcher], {stdout: "ignore", stderr: "pipe", env: {...process.env, WORKER_FIXTURE_SECRET: "must-not-inherit"}});
 expect(await parent.exited).toBe(0);
 const {pid} = JSON.parse(await readFile(path.join(f.directory, "spawn.json"), "utf8")); groups.push(pid);
 await poll(() => exists(first + ".started"));
 const started = JSON.parse(await readFile(first + ".started", "utf8"));
 expect(started.electron).toBeDefined(); expect(started.keys).not.toContain("WORKER_FIXTURE_SECRET");
 expect(() => process.kill(started.pid, 0)).not.toThrow();
 const inode = (await lstat(path.join(f.directory, "worker.lock"))).ino;
 const contender = await launchDesktopUpdateWorker({...f, arguments: [second]}); groups.push(contender.pid);
 await poll(async () => {try {process.kill(contender.pid, 0); return false;} catch {return true;}});
 expect(await exists(second + ".started")).toBe(false);
 await writeFile(first + ".release", "");
 await poll(async () => {try {process.kill(started.pid, 0); return false;} catch {return true;}});
 const retry = await launchDesktopUpdateWorker({...f, arguments: [second]}); groups.push(retry.pid);
 await poll(() => exists(second + ".started"));
 expect((await lstat(path.join(f.directory, "worker.lock"))).ino).toBe(inode);
}), 20000);

nativeTest("abrupt worker death releases the kernel lock without deleting or stealing a PID file", () => fixture(async (f, groups) => {
 const first = path.join(f.directory, "first"), second = path.join(f.directory, "second");
 const launch = await launchDesktopUpdateWorker({...f, arguments: [first]}); groups.push(launch.pid);
 await poll(() => exists(first + ".started"));
 const {pid} = JSON.parse(await readFile(first + ".started", "utf8"));
 process.kill(pid, "SIGKILL");
 await poll(async () => {try {process.kill(launch.pid, 0); return false;} catch {return true;}});
 const retry = await launchDesktopUpdateWorker({...f, arguments: [second]}); groups.push(retry.pid);
 await poll(() => exists(second + ".started"));
 expect(await exists(path.join(f.directory, "worker.lock"))).toBe(true);
}), 15000);

nativeTest("refuses public staging and a symlink lock before executing a worker", () => fixture(async (f) => {
 await chmod(f.directory, 0o755);
 await expect(launchDesktopUpdateWorker(f)).rejects.toThrow("UPDATE_WORKER_LAUNCH_FAILED");
 await chmod(f.directory, 0o700);
 const target = path.join(f.directory, "untouched"); await writeFile(target, "original", {mode: 0o600});
 await symlink(target, path.join(f.directory, "worker.lock"));
 await expect(launchDesktopUpdateWorker(f)).rejects.toThrow("UPDATE_WORKER_LAUNCH_FAILED");
 expect(await readFile(target, "utf8")).toBe("original");
}));

nativeTest("lock helper becomes the worker so no separate supervisor can release its lock", () => fixture(async (f, groups) => {
 const first = path.join(f.directory, "first"), second = path.join(f.directory, "second");
 const launch = await launchDesktopUpdateWorker({...f, arguments: [first]}); groups.push(launch.pid);
 await poll(() => exists(first + ".started"));
 const {pid} = JSON.parse(await readFile(first + ".started", "utf8"));
 expect(launch.pid).toBe(pid);
 expect(() => process.kill(pid, 0)).not.toThrow();
 const contender = await launchDesktopUpdateWorker({...f, arguments: [second]}); groups.push(contender.pid);
 await poll(async () => {try {process.kill(contender.pid, 0); return false;} catch {return true;}});
 expect(await exists(second + ".started")).toBe(false);
}), 15000);
nativeTest("launcher refuses shared and duplicate state leases without releasing the host's lease", () => fixture(async f => {
 const databasePath = path.join(f.directory, "operations.sqlite"), shared = acquireSqliteAccess(databasePath)!;
 try {await expect(launchDesktopUpdateWorker({...f, stateAccess: [{databasePath, lease: shared}]})).rejects.toThrow("UPDATE_WORKER_LAUNCH_FAILED");} finally {shared.close();}
 const exclusive = acquireSqliteAccess(databasePath, true)!;
 try {
  await expect(launchDesktopUpdateWorker({...f, stateAccess: [{databasePath, lease: exclusive}, {databasePath, lease: exclusive}]})).rejects.toThrow("UPDATE_WORKER_LAUNCH_FAILED");
  expect(() => acquireSqliteAccess(databasePath)).toThrow("SQLITE_ACCESS_UNAVAILABLE");
 } finally {exclusive.close();}
}));
nativeTest("a lease released during asynchronous launch preparation cannot be transferred", () => fixture(async f => {
 const databasePath = path.join(f.directory, "operations.sqlite"), lease = acquireSqliteAccess(databasePath, true)!;
 const launched = launchDesktopUpdateWorker({...f, stateAccess: [{databasePath, lease}]});
 lease.close();
 await expect(launched).rejects.toThrow("UPDATE_WORKER_LAUNCH_FAILED");
 const next = acquireSqliteAccess(databasePath, true)!; next.close();
}));
