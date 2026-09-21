import {spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
const packaged = process.argv.includes("--packaged");
const executable = packaged ? path.join(root, "out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness") : path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const report = await mkdtemp("/tmp/har-state-gate-");
const rows = [];
for (const [name, payload, code] of [
 ["future", '{"format":2,"phase":"ready"}', "DESKTOP_STATE_INCOMPATIBLE"],
 ["interrupted", '{"format":1,"phase":"migrating"}', "DESKTOP_STATE_RECOVERY_REQUIRED"],
 ["invalid", "synthetic private data must not appear in diagnostic", "DESKTOP_STATE_INVALID"],
]) {
 const directory = path.join(report, name!);
 const markerDirectory = path.join(directory, "user-data/state-compatibility");
 await mkdir(markerDirectory, {recursive: true, mode: 0o700});
 const marker = path.join(markerDirectory, "format.json");
 await writeFile(marker, payload!, {mode: 0o600});
 const child = spawn(executable, [...(packaged ? [] : [root]), "--smoke-test", "--report-directory", directory], {cwd: root, env: {PATH: process.env.PATH, HOME: directory}, stdio: "ignore"});
 const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
 let exit;
 try {exit = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});}
 finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");}
 const diagnostic = JSON.parse(await readFile(path.join(directory, "state-format-failure.json"), "utf8"));
 const profile = await readdir(path.join(directory, "user-data"));
 const unchanged = await readFile(marker, "utf8") === payload;
 const pass = exit === 1 && JSON.stringify(diagnostic) === JSON.stringify({code}) && unchanged && !profile.includes("projects") && !profile.includes("tasks");
 rows.push({name, exit, code: diagnostic.code, markerUnchanged: unchanged, registriesNotOpened: !profile.includes("projects") && !profile.includes("tasks"), pass});
 if (!pass) throw new Error(`STATE_GATE_FAILED: ${directory}`);
}
await writeFile(path.join(report, "report.json"), JSON.stringify({packaged, rows}, null, 2));
console.log(JSON.stringify({report, packaged, rows}));
