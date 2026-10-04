import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Harness uses a 20-hex workspace identity and a conservative 100-byte limit.
const socketFilename = `${"0".repeat(20)}.sock`;
const fits = (directory: string) =>
  Buffer.byteLength(path.join(directory, socketFilename)) <= 100;

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("LOCAL_SERVICE_DIRECTORY_UNSAFE");
  return realpath(directory);
}

/** Preflight the canonical path; never relocate existing service state or repair permissions. */
export async function selectWebServiceDirectory(
  temporaryRoot = os.tmpdir(),
  shortRoot = "/tmp",
) {
  const name = `zhivex-code-web-${process.getuid?.() ?? "user"}`;
  const preferred = await privateDirectory(path.join(temporaryRoot, name));
  if (fits(preferred)) return preferred;
  // An occupied preferred directory needs explicit investigation/recovery,
  // rather than silently hiding its lock, credentials or socket elsewhere.
  if ((await readdir(preferred)).length)
    throw new Error("WEB_SERVICE_LOCATION_OCCUPIED");
  const fallback = await privateDirectory(path.join(shortRoot, name));
  if (!fits(fallback)) throw new Error("LOCAL_SERVICE_SOCKET_PATH_TOO_LONG");
  return fallback;
}

const reasons = new Set([
  "LOCAL_SERVICE_DIRECTORY_UNSAFE",
  "LOCAL_SERVICE_SOCKET_PATH_TOO_LONG",
  "LOCAL_SERVICE_STALE_STATE",
  "LOCAL_SERVICE_LOCK_UNSAFE",
  "LOCAL_SERVICE_OWNER_ALIVE",
  "LOCAL_SERVICE_RECOVERY_UNSAFE",
]);
const systemReasons = new Map([
  ["EACCES", "PERMISSION_DENIED"],
  ["EPERM", "PERMISSION_DENIED"],
  ["EEXIST", "SERVICE_STATE_EXISTS"],
  ["EADDRINUSE", "ADDRESS_IN_USE"],
]);
const webCodes = new Set([
  "WEB_USAGE_INVALID", "WEB_PLATFORM_UNSUPPORTED", "WEB_WORKSPACE_INVALID",
  "WEB_CREDENTIALS_REQUIRED", "WEB_PROTOCOL_UNSUPPORTED", "WEB_ASSETS_MISSING",
  "WEB_ASSETS_UNSAFE", "WEB_PORT_INVALID", "WEB_LISTEN_FAILED",
  "WEB_LOOPBACK_REQUIRED", "WEB_BROWSER_OPEN_FAILED", "WEB_SERVICE_LOCATION_OCCUPIED",
]);

/** Fixed reason codes only: never print an arbitrary filesystem/configuration error. */
export function webStartupDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return "WEB_START_FAILED";
  if (webCodes.has(error.message)) return error.message;
  if (reasons.has(error.message))
    return `WEB_START_FAILED (${error.message})`;
  const reason = systemReasons.get((error as NodeJS.ErrnoException).code ?? "");
  return reason ? `WEB_START_FAILED (${reason})` : "WEB_START_FAILED";
}
