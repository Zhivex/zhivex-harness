import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, mkdtemp, open, realpath, rename, rm} from "node:fs/promises";
import path from "node:path";
import {requireVerifiedUpdate, type VerifiedUpdate} from "./update-manifest.js";

const redirectHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
function redirectTarget(value: string, from: string) {
 const url = new URL(value, from);
 if (url.protocol !== "https:" || !redirectHosts.has(url.hostname) || url.port || url.username || url.password || url.hash) throw new Error("UPDATE_REDIRECT_REJECTED");
 return url.href;
}
/** Download only. A staged DMG is NOT an approved installation or a macOS signature proof. */
export async function stageUpdateDownload(update: VerifiedUpdate, options: {
 directory: string; signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number;
}): Promise<{directory: string; artifact: string; sha256: string; size: number}> {
 requireVerifiedUpdate(update);
 const timeout = options.timeoutMs ?? 5 * 60_000;
 if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10 * 60_000) throw new Error("UPDATE_TIMEOUT_INVALID");
 const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
 if (signal.aborted) throw new Error("UPDATE_DOWNLOAD_FAILED");
 let directory: string;
 try {
  await mkdir(options.directory, {recursive: true, mode: 0o700});
  const stat = await lstat(options.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
  directory = await mkdtemp(path.join(await realpath(options.directory), "download-"));
 } catch { throw new Error("UPDATE_DIRECTORY_UNSAFE"); }
 const partial = path.join(directory, "artifact.part"), artifact = path.join(directory, "update.dmg");
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 let response: Response | undefined;
 let abortListener: (() => void) | undefined;
 const aborted = new Promise<never>((_, reject) => {
  abortListener = () => reject(new Error("UPDATE_DOWNLOAD_ABORTED"));
  signal.addEventListener("abort", abortListener, {once: true});
  if (signal.aborted) abortListener();
 });
 // Keep rejection handled while file operations, rather than a network await, are pending.
 void aborted.catch(() => {});
 try {
  const fetcher = options.fetch ?? fetch;
  let url = update.artifact.url;
  for (let hop = 0; hop <= 3; hop++) {
   response = await Promise.race([fetcher(url, {signal, redirect: "manual", credentials: "omit", headers: {"Accept-Encoding": "identity"}}), aborted]);
   if (![301, 302, 303, 307, 308].includes(response.status)) break;
   void response.body?.cancel().catch(() => {});
   const location = response.headers.get("location");
   if (!location || hop === 3) throw new Error();
   url = redirectTarget(location, url);
  }
  if (!response || response.status !== 200 || !response.body) throw new Error();
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") throw new Error();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== update.artifact.size)) throw new Error();
  reader = response.body.getReader();
  const file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256"); let size = 0;
  try {
   while (true) {
    const chunk = await Promise.race([reader.read(), aborted]);
    if (chunk.done) break;
    signal.throwIfAborted(); size += chunk.value.byteLength;
    if (size > update.artifact.size) throw new Error();
    hash.update(chunk.value); await file.writeFile(chunk.value);
   }
   if (size !== update.artifact.size || hash.digest("hex") !== update.artifact.sha256) throw new Error();
   signal.throwIfAborted(); requireVerifiedUpdate(update); await file.sync();
  } finally { await file.close(); }
  await rename(partial, artifact);
  return {directory, artifact, size, sha256: update.artifact.sha256};
 } catch {
  try {await rm(directory, {recursive: true, force: true});}
  catch {throw new Error("UPDATE_DOWNLOAD_CLEANUP_FAILED");}
  throw new Error("UPDATE_DOWNLOAD_FAILED");
 } finally {
  if (abortListener) signal.removeEventListener("abort", abortListener);
  void reader?.cancel().catch(() => {});
  if (!reader) void response?.body?.cancel().catch(() => {});
 }
}
