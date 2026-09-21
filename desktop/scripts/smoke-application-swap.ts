import {cp, mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {execFileSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {createApplicationSwapper} from "../src/application-swap.js";

const root = path.resolve(import.meta.dir, ".."), temporary = await mkdtemp("/tmp/har-bundle-swap-");
const reportDirectory = await mkdtemp("/tmp/har-bundle-swap-report-");
const source = path.join(root, "out/Zhivex Harness-darwin-arm64/Zhivex Harness.app"), application = path.join(temporary, "Applications/Zhivex Harness.app"), candidate = path.join(temporary, "Candidate.app");
const oldVersion = (await Bun.file(path.join(root, "package.json")).json()).version, newVersion = "99.0.0-fixture.1";
const digest = async (app: string) => createHash("sha256").update(await readFile(path.join(app, "Contents/Resources/app.asar"))).digest("hex");
const plist = (app: string) => JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")], {encoding: "utf8"}));
try {
 await mkdir(path.dirname(application), {recursive: true});
 await cp(source, application, {recursive: true, verbatimSymlinks: true, preserveTimestamps: true});
 await cp(source, candidate, {recursive: true, verbatimSymlinks: true, preserveTimestamps: true});
 execFileSync("/usr/bin/plutil", ["-replace", "ZhivexDesktopVersion", "-string", newVersion, path.join(candidate, "Contents/Info.plist")]);
 const asar = await digest(source);
 // Explicit unsigned fixture adapter. Production createApplicationSwapper defaults to native verification.
 const swapper = createApplicationSwapper(async (app, policy) => {
  if (plist(app).ZhivexDesktopVersion !== policy.version || await digest(app) !== asar) throw new Error("FIXTURE_BUNDLE_CHANGED");
 });
 const swap = await swapper.prepare({application, candidate, teamId: "ZZZZZZZZZZ", previousVersion: oldVersion, nextVersion: newVersion});
 const stopped = {assertStopped: async () => {}}; // Neither temporary bundle has been launched yet.
 await swapper.activate(swap, stopped);
 if (plist(swap.application).ZhivexDesktopVersion !== newVersion) throw new Error("FIXTURE_INSTALL_FAILED");
 let interrupted = false;
 try {await swapper.rollback(swap, {...stopped, afterMove: async step => {if (step === 1) throw new Error("fixture power loss");}});} catch {interrupted = true;}
 if (!interrupted) throw new Error("FIXTURE_INTERRUPTION_MISSING");
 await swapper.rollback(swap, stopped);
 if (plist(swap.application).ZhivexDesktopVersion !== oldVersion || await digest(swap.application) !== asar) throw new Error("FIXTURE_RESTORE_FAILED");
 const child = spawn(process.execPath, [path.join(root, "scripts/smoke.ts"), "--packaged", "--empty-start", "--app-path", swap.application], {cwd: root, env: {PATH: process.env.PATH, HOME: temporary}, stdio: ["ignore", "pipe", "pipe"]});
 let stdout = ""; child.stdout.on("data", chunk => {stdout = (stdout + chunk).slice(-65536);}); child.stderr.resume();
 const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
 try {const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);}); if (code !== 0) throw new Error("RESTORED_APP_SMOKE_FAILED");}
 finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");}
 const smoke = JSON.parse(stdout.trim().split("\n").at(-1)!);
 const report = {temporaryApplications: true, realElectronBundles: true, applicationSwapped: true, rollbackInterruptionRecovered: true, restoredAsarVerified: true, nativeSignatureFixture: true, signedUpdateVerified: false, smoke};
 await writeFile(path.join(reportDirectory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({reportDirectory, ...report}));
} finally {await rm(temporary, {recursive: true, force: true});}
