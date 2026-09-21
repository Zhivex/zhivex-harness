import {test, expect} from "bun:test";
import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {createMacApplicationVerifier} from "../src/mac-application-verifier.js";
const policy = {teamId: "ABCDEFGHIJ", version: "0.1.0-alpha.1"};
async function fixture(run: (app: string) => Promise<void>) {
 const root = await mkdtemp("/tmp/har-mac-verify-"); const app = path.join(root, "Zhivex Harness.app");
 await mkdir(path.join(app, "Contents/Resources"), {recursive: true}); await writeFile(path.join(app, "Contents/Resources/credential-store"), "fixture, never executable");
 await writeFile(path.join(app, "Contents/Resources/update-worker-lock"), "fixture, never executable");
 try {await run(app);} finally {await rm(root, {recursive: true, force: true});}
}
const plist = {CFBundleIdentifier: "ai.zhivex.harness", ZhivexDesktopVersion: policy.version, CFBundleShortVersionString: "0.1.0", CFBundleVersion: "0.1.0", CFBundleExecutable: "Zhivex Harness"};
async function valid(binary: string, args: string[]) {
 if (binary.endsWith("plutil")) return {stdout: JSON.stringify(plist), stderr: ""};
 if (binary.endsWith("lipo")) return {stdout: "arm64\n", stderr: ""};
 if (binary.endsWith("spctl")) return {stdout: "", stderr: "fixture: accepted\nsource=Notarized Developer ID\n"};
 if (args.includes("--display")) return {stdout: "", stderr: "CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=10+7 location=embedded\n"};
 return {stdout: "", stderr: ""};
}
test("native policy requires pinned Developer ID for app and helper, hardened runtime and notarized origin", () => fixture(async app => {
 const calls: Array<{binary: string; args: string[]}> = [];
 const verify = createMacApplicationVerifier(async (binary, args) => {calls.push({binary, args}); return valid(binary, args);}, "darwin");
 const result = await verify(app, policy); expect(result.notarized).toBe(true); expect(result.version).toBe(policy.version);
 const requirements = calls.filter(c => c.args.includes("-R")); expect(requirements).toHaveLength(3);
 expect(requirements[0]!.args).toContain("--deep");
 expect(requirements[0]!.args.join(" ")).toContain('certificate leaf[subject.OU] = "ABCDEFGHIJ"');
 expect(requirements[1]!.args.join(" ")).toContain('identifier "ai.zhivex.harness.credential-store"');
 expect(requirements[2]!.args.join(" ")).toContain('identifier "ai.zhivex.harness.update-worker-lock"');
 expect(calls.at(-1)!.args).toContain("--ignore-cache"); expect(calls.every(c => !c.binary.includes("xcrun"))).toBe(true);
}));
test("unsigned, wrong publisher or unnotarized app fail before returning an accepted candidate", () => fixture(async app => {
 for (const failure of ["signature", "helper", "update-helper", "runtime", "override", "ambiguous-origin", "architecture", "version"]) {
  let seenSignatures = 0;
  const verify = createMacApplicationVerifier(async (binary, args) => {
   if (args.includes("--verify")) {seenSignatures++; if (failure === "signature" || (failure === "helper" && seenSignatures === 2) || (failure === "update-helper" && seenSignatures === 3)) throw new Error("synthetic private diagnostic");}
   if (failure === "runtime" && args.includes("--display")) return {stdout: "", stderr: "CodeDirectory flags=0x2(adhoc)"};
   if (failure === "override" && binary.endsWith("spctl")) return {stdout: "accepted", stderr: "source=User ID"};
   if (failure === "ambiguous-origin" && binary.endsWith("spctl")) return {stdout: "source=Notarized Developer ID", stderr: "source=User ID"};
   if (failure === "architecture" && binary.endsWith("lipo")) return {stdout: "x86_64", stderr: ""};
   if (failure === "version" && binary.endsWith("plutil")) return {stdout: JSON.stringify({...plist, ZhivexDesktopVersion: "9.0.0"}), stderr: ""};
   return valid(binary, args);
  }, "darwin");
  await expect(verify(app, policy)).rejects.toThrow("UPDATE_APPLICATION_REJECTED");
 }
}));
test("unconfigured publisher and unsupported platform never spawn commands", () => fixture(async app => {
 let calls = 0; const command = async () => {calls++; return {stdout: "", stderr: ""};};
 await expect(createMacApplicationVerifier(command, "darwin")(app, {...policy, teamId: '" or true'})).rejects.toThrow("UPDATE_PUBLISHER_NOT_CONFIGURED");
 await expect(createMacApplicationVerifier(command, "linux")(app, policy)).rejects.toThrow("UPDATE_PUBLISHER_NOT_CONFIGURED"); expect(calls).toBe(0);
}));
test("bundle symlinks are not accepted as a candidate", () => fixture(async app => {
 const link = path.join(path.dirname(app), "Alias.app"); await symlink(app, link);
 await expect(createMacApplicationVerifier(valid, "darwin")(link, policy)).rejects.toThrow("UPDATE_APPLICATION_REJECTED");
}));
test("update lock helper must exist as a real file inside the application", () => fixture(async app => {
 const helper = path.join(app, "Contents/Resources/update-worker-lock"); await rm(helper);
 await expect(createMacApplicationVerifier(valid, "darwin")(app, policy)).rejects.toThrow("UPDATE_APPLICATION_REJECTED");
 await symlink("credential-store", helper);
 await expect(createMacApplicationVerifier(valid, "darwin")(app, policy)).rejects.toThrow("UPDATE_APPLICATION_REJECTED");
}));
