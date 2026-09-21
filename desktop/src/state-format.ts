import {constants} from "node:fs";
import {link, lstat, mkdir, open, realpath, unlink} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {z} from "zod";

export const DESKTOP_STATE_FORMAT = 1;
const schema = z.object({format: z.number().int().min(1).max(1_000_000), phase: z.enum(["ready", "migrating"])}).strict();
export type DesktopStateFailure = "DESKTOP_STATE_INCOMPATIBLE" | "DESKTOP_STATE_RECOVERY_REQUIRED" | "DESKTOP_STATE_INVALID";
export class DesktopStateError extends Error {
 constructor(readonly code: DesktopStateFailure) {super(code);}
}
/** Must run before registries, runtime recovery or any project admission. No implicit downgrade. */
export async function checkDesktopStateFormat(userData: string): Promise<void> {
 const directory = path.join(userData, "state-compatibility");
 try {
  // The recovery intent is written before the format marker. Any surviving intent
  // blocks startup even if power was lost before the marker changed (or after reset).
  try {await lstat(path.join(userData, "update-recovery/active.json")); throw new DesktopStateError("DESKTOP_STATE_RECOVERY_REQUIRED");}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error();
  const filename = path.join(await realpath(directory), "format.json");
  const read = async () => {
   const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024) throw new Error();
    // A fixed-size descriptor read remains bounded even if another process appends.
    const bytes = Buffer.alloc(1025); const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 1024) throw new Error();
    return schema.parse(JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")));
   } finally {await file.close();}
  };
  let state;
  try {state = await read();}
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   const temporary = path.join(directory, `.format-${randomUUID()}`);
   const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
   try {
    try {await file.writeFile(JSON.stringify({format: DESKTOP_STATE_FORMAT, phase: "ready"})); await file.sync();}
    finally {await file.close();}
    // Publish without replacing a concurrently created marker.
    try {await link(temporary, filename);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
   } finally {await unlink(temporary);}
   state = await read();
  }
  if (state.format !== DESKTOP_STATE_FORMAT) throw new DesktopStateError("DESKTOP_STATE_INCOMPATIBLE");
  if (state.phase !== "ready") throw new DesktopStateError("DESKTOP_STATE_RECOVERY_REQUIRED");
 } catch (error) {
  if (error instanceof DesktopStateError) throw error;
  throw new DesktopStateError("DESKTOP_STATE_INVALID");
 }
}
