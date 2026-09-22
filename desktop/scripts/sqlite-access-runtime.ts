import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile, access} from "node:fs/promises";
import path from "node:path";
import {SqliteDatabase} from "../../src/persistence/sqlite-database.js";
import {acquireSqliteAccess} from "../../src/persistence/sqlite-access.js";
async function poll(check: () => Promise<boolean>) {const until = Date.now() + 8000; while (Date.now() < until) {if (await check()) return; await new Promise(r => setTimeout(r, 25));} throw new Error("FIXTURE_TIMEOUT");}
async function peer() {
 const file = process.argv[3]!;
 let lease;
 try {lease = acquireSqliteAccess(file, true)!;} catch {process.exitCode = 75; return;}
 if (process.argv[2] === "probe") {lease.close(); return;}
 const own = new SqliteDatabase(file, {accessLease: lease});
 assert.equal(own.query<{n: number}>("SELECT n FROM value").get()!.n, 7);
 await writeFile(file + ".ready", String(process.pid));
 const timer = setInterval(() => {}, 1000);
 setTimeout(() => {clearInterval(timer); own.close(); lease.close();}, 15000).unref();
}
async function parent() {
 const root = await realpath(await mkdtemp("/tmp/har-native-access-")), file = path.join(root, "operations.sqlite");
 let child: ReturnType<typeof spawn> | undefined, db: SqliteDatabase | undefined;
 const start = (mode: string) => {
  child = spawn(process.execPath, [process.argv[1]!, mode, file], {stdio: "ignore", env: {PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1"}});
  const processHandle = child;
  return {child: processHandle, exited: new Promise<number | null>((resolve, reject) => {processHandle.once("exit", resolve); processHandle.once("error", reject);})};
 };
 try {
  db = new SqliteDatabase(file); db.exec("CREATE TABLE value(n INTEGER); INSERT INTO value VALUES(7)");
  assert.equal(await start("probe").exited, 75); db.close(); db = undefined;
  const owner = start("hold"); await poll(() => access(file + ".ready").then(() => true, () => false));
  assert.throws(() => new SqliteDatabase(file), /SQLITE_ACCESS_UNAVAILABLE/);
  owner.child.kill("SIGKILL"); await owner.exited;
  db = new SqliteDatabase(file); assert.equal(db.query<{n: number}>("SELECT n FROM value").get()!.n, 7); db.close(); db = undefined;
  const evidence = await mkdtemp("/tmp/har-access-report-");
  const report = {node: process.versions.node, electron: process.versions.electron, liveConnectionBlocksExclusivePeer: true, exclusivePeerBlocksNewConnection: true, killedOwnerReleasesKernelLock: true, contentsPreserved: true, pass: true};
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({evidence, ...report}));
 } finally {db?.close(false); if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(root, {recursive: true, force: true});}
}
void (process.argv[2] ? peer() : parent()).catch(() => {console.error("NATIVE_SQLITE_ACCESS_FAILED"); process.exitCode = 1;});
