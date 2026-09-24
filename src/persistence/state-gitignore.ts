import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { HarnessWorkspaceError } from "../runtime/errors.js";

const exclusion = "# Local Harness state; never commit sessions, runs, or database journals.\n*\n";

const maximumExistingBytes = 65536;
const maximumProtectedBytes = maximumExistingBytes + Buffer.byteLength(exclusion) + 1;

/** Call after validating and creating the state directory, before writing state. */
export async function protectStateFromGit(workspace: string, stateDirectory: string): Promise<void> {
  const directory = path.resolve(stateDirectory) === path.join(workspace, ".zhivex-harness", "runs")
    ? path.dirname(stateDirectory) : stateDirectory;
  const filename = path.join(directory, ".gitignore");
  try {
    const handle = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat();
      const entry = await lstat(filename);
      if (entry.isSymbolicLink() || entry.dev !== info.dev || entry.ino !== info.ino) throw new Error();
      if (!info.isFile() || info.nlink !== 1 ||
          (process.getuid && info.uid !== process.getuid()) || info.size > maximumProtectedBytes) throw new Error();
      const buffer = Buffer.alloc(maximumProtectedBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maximumProtectedBytes) throw new Error();
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      if (!content.endsWith(exclusion)) {
        if (bytesRead > maximumExistingBytes) throw new Error();
        await handle.writeFile(`${content && !content.endsWith("\n") ? "\n" : ""}${exclusion}`);
      }
      const current = await lstat(filename);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new Error();
    } finally { await handle.close(); }
  } catch (cause) {
    throw new HarnessWorkspaceError("Cannot protect the local state directory with a safe .gitignore.", { cause });
  }
}
