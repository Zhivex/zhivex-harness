import {execFile} from "node:child_process";
import {lstat, realpath} from "node:fs/promises";
import path from "node:path";
import {compareUpdateVersions} from "./update-manifest.js";

type Command = (binary: string, args: string[]) => Promise<{stdout: string; stderr: string}>;
const nativeCommand: Command = (binary, args) => new Promise((resolve, reject) => {
 execFile(binary, args, {encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024,
  env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C"}}, (error, stdout, stderr) => {
  if (error) reject(new Error("MAC_VERIFICATION_COMMAND_FAILED")); else resolve({stdout, stderr});
 });
});
const PRODUCT = "ai.zhivex.harness";
function requirement(identifier: string, team: string) {
 return `identifier "${identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

/** Only the host supplies identity/version. Native command injection is for fixtures, never IPC.
 * Uses tools shipped with macOS; Xcode/Command Line Tools are not an end-user dependency.
 */
export function createMacApplicationVerifier(command: Command = nativeCommand, platform: string = process.platform) {
 return async (requested: string, policy: {teamId: string; version: string}) => {
  if (platform !== "darwin" || !/^[A-Z0-9]{10}$/.test(policy.teamId)) throw new Error("UPDATE_PUBLISHER_NOT_CONFIGURED");
  try {
   compareUpdateVersions(policy.version, policy.version);
   if (!path.isAbsolute(requested) || !requested.endsWith(".app") || /[\x00-\x1f\x7f]/.test(requested)) throw new Error();
   const entry = await lstat(requested); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
   const application = await realpath(requested);
   const helpers = ["credential-store", "update-worker-lock"].map(name => ({name, binary: path.join(application, "Contents/Resources", name)}));
   for (const helper of helpers) {const info = await lstat(helper.binary); if (!info.isFile() || info.isSymbolicLink()) throw new Error();}
   // Signature identity is enforced by the OS, not inferred from text printed by an untrusted app.
   await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "-R", requirement(PRODUCT, policy.teamId), application]);
   for (const helper of helpers) await command("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", requirement(`${PRODUCT}.${helper.name}`, policy.teamId), helper.binary]);
   const plist = JSON.parse((await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(application, "Contents/Info.plist")])).stdout);
   const numeric = policy.version.split(/[+-]/)[0];
   if (plist.CFBundleIdentifier !== PRODUCT || plist.ZhivexDesktopVersion !== policy.version || plist.CFBundleShortVersionString !== numeric || plist.CFBundleVersion !== numeric || plist.CFBundleExecutable !== "Zhivex Harness") throw new Error();
   for (const binary of [path.join(application, "Contents/MacOS/Zhivex Harness"), ...helpers.map(h => h.binary)]) {
    if ((await command("/usr/bin/lipo", ["-archs", binary])).stdout.trim() !== "arm64") throw new Error();
    const details = await command("/usr/bin/codesign", ["--display", "--verbose=4", binary]);
    if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/im.test(details.stderr + details.stdout)) throw new Error();
   }
   // Do not accept local user overrides or a merely valid Developer ID certificate.
   // Requiring the notarized assessment origin fails closed if macOS cannot establish it.
   const assessment = await command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", "--ignore-cache", "--no-cache", application]);
   const origins = (assessment.stderr + "\n" + assessment.stdout).split(/\r?\n/).filter(line => line.startsWith("source="));
   if (origins.length !== 1 || origins[0]!.trim() !== "source=Notarized Developer ID") throw new Error();
   return Object.freeze({application, version: policy.version, teamId: policy.teamId, architecture: "arm64" as const, notarized: true as const});
  } catch {throw new Error("UPDATE_APPLICATION_REJECTED");}
 };
}
