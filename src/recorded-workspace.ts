import {lstat, realpath} from "node:fs/promises";
import path from "node:path";

/** Validate an already-recorded canonical identity without creating its checkout.
 * Missing paths are allowed only for archive/restore callers holding that identity.
 */
export async function validateRecordedWorkspace(workspace: string, allowAbsent = false): Promise<string> {
 if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace || /[\x00-\x1f\x7f]/.test(workspace)) throw new Error("RECORDED_WORKSPACE_INVALID");
 let ancestor = workspace;
 for (;;) {
  try {
   const info = await lstat(ancestor);
   if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new Error("RECORDED_WORKSPACE_INVALID");
   return workspace;
  } catch (error) {
   if (!allowAbsent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error("RECORDED_WORKSPACE_INVALID"); ancestor = parent;
  }
 }
}
