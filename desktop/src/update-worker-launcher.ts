import {spawn} from "node:child_process";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import path from "node:path";

/** Host-only launch primitive. The private directory and bundled worker must be
 * staged outside the application before launch. Arguments contain paths/IDs only.
 * A returned PID proves spawn, not lock acquisition, installation or readiness;
 * the caller must await the worker's durable acknowledgement before quitting.
 * This serializes update workers only, not arbitrary database owners.
 * The worker must keep inherited fd 3 open for its entire lifetime. Neither
 * the host nor the worker may unlink/replace worker.lock or its private directory.
 * executable/helper are trusted host build paths; this function does not certify
 * their publisher. The packaged helper must join the release signature policy.
 */
export async function launchDesktopUpdateWorker(input: {
 directory: string; executable: string; helper: string; worker: string; arguments: string[];
}): Promise<{pid: number}> {
 try {
  if (process.platform !== "darwin" || input.arguments.length > 8 ||
      input.arguments.some(a => a.length > 4096 || /[\x00-\x1f\x7f]/.test(a))) throw new Error();
  for (const value of [input.directory, input.executable, input.helper, input.worker]) {
   if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || await realpath(value) !== value) throw new Error();
  }
  const directory = await lstat(input.directory), worker = await lstat(input.worker), executable = await lstat(input.executable), helper = await lstat(input.helper);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) ||
      path.dirname(input.worker) !== input.directory || !worker.isFile() || worker.nlink !== 1 ||
      worker.uid !== process.getuid?.() || (worker.mode & 0o077) || !executable.isFile() || !(executable.mode & 0o111) ||
      !helper.isFile() || !(helper.mode & 0o111)) throw new Error();
  // Keep one inode forever. Unlinking a lock file permits competing lock domains.
  // Passing the checked descriptor avoids reopening an unchecked path.
  const lock = await open(path.join(input.directory, "worker.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
   const info = await lock.stat();
   if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size !== 0) throw new Error();
   await lock.sync();
   const child = spawn(input.helper, [input.executable, input.worker, ...input.arguments], {
    cwd: input.directory, detached: true,
    stdio: ["ignore", "ignore", "ignore", lock.fd],
    // Never inherit provider keys, NODE_OPTIONS, loader hooks or Electron flags.
    env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", ELECTRON_RUN_AS_NODE: "1"},
   });
   await new Promise<void>((resolve, reject) => {child.once("spawn", resolve); child.once("error", reject);});
   child.unref();
   if (!child.pid) throw new Error();
   return {pid: child.pid};
  } finally {await lock.close();}
 } catch {throw new Error("UPDATE_WORKER_LAUNCH_FAILED");}
}
