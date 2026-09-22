import {mkdir} from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("UPDATE_WORKER_PLATFORM_UNSUPPORTED");
const root = path.resolve(import.meta.dir, "..");
await mkdir(path.join(root, "build"), {recursive: true});
const compiler = Bun.spawn(["/usr/bin/swiftc", "-target", "arm64-apple-macos13.0", "-O", "-module-cache-path", path.join(root, "node_modules/.cache/swift"), path.join(root, "native/UpdateWorkerLock.swift"), "-o", path.join(root, "build/update-worker-lock")], {stdout: "inherit", stderr: "inherit"});
if (await compiler.exited !== 0) throw new Error("UPDATE_WORKER_HELPER_BUILD_FAILED");
console.log("Native macOS update worker lock helper built.");
