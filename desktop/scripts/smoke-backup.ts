import {spawn} from "node:child_process";
import {mkdtemp} from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dir, ".."), directory = await mkdtemp("/tmp/har-backup-bundle-");
const metadata = await Bun.file(path.join(root, "../package.json")).json();
const result = await Bun.build({entrypoints: [path.join(import.meta.dir, process.argv.includes("--recovery") ? "state-transaction-runtime.ts" : "backup-runtime-verification.ts")], outdir: directory, naming: "verify.cjs", format: "cjs", target: "node", plugins: [{name: "native-backup-runtime", setup(builder) {
 builder.onLoad({filter: /[\\/]src[\\/]sqlite-database\.ts$/}, async args => ({contents: (await Bun.file(args.path).text()).replace("createRequire(import.meta.url)", "createRequire(process.execPath)"), loader: "ts"}));
 builder.onLoad({filter: /[\\/]src[\\/]version\.ts$/}, () => ({contents: `export const HARNESS_VERSION=${JSON.stringify(metadata.version)}; export const NODE_ENGINE_RANGE=${JSON.stringify(metadata.engines.node)}; export const BUN_ENGINE_RANGE=${JSON.stringify(metadata.engines.bun)};`, loader: "ts"}));
}}]});
if (!result.success) throw new Error("BACKUP_FIXTURE_BUILD_FAILED");
const child = spawn(path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [path.join(directory, "verify.cjs")], {cwd: directory, env: {PATH: process.env.PATH, HOME: directory, ELECTRON_RUN_AS_NODE: "1"}, stdio: "inherit"});
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
try {const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);}); if (code !== 0) throw new Error("NATIVE_BACKUP_CHECK_FAILED");}
finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");}
