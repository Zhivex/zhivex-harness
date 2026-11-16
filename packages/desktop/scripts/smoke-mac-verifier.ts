import {execFileSync} from "node:child_process";
import {mkdtemp, writeFile} from "node:fs/promises";
import path from "node:path";
import {createMacApplicationVerifier} from "../src/mac-application-verifier.js";
const root = path.resolve(import.meta.dir, ".."), app = path.join(root, "out/Zhivex Harness-darwin-arm64/Zhivex Harness.app");
const version = (await Bun.file(path.join(root, "package.json")).json()).version;
const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")], {encoding: "utf8"}));
const numeric = version.split(/[+-]/)[0];
if (plist.ZhivexDesktopVersion !== version || plist.CFBundleVersion !== numeric || plist.CFBundleShortVersionString !== numeric) throw new Error("BUNDLE_VERSION_CHECK_FAILED");
let rejected = false;
try {await createMacApplicationVerifier()(app, {teamId: "ZZZZZZZZZZ", version});}
catch (error) {if (error instanceof Error && error.message === "UPDATE_APPLICATION_REJECTED") rejected = true; else throw new Error("UNEXPECTED_VERIFIER_FAILURE");}
if (!rejected) throw new Error("UNSIGNED_APPLICATION_ACCEPTED");
const report = {version, numericVersion: numeric, unsignedPackageRejected: rejected, productionPublisherConfigured: false, signedPositiveCaseVerified: false};
const directory = await mkdtemp("/tmp/har-mac-verifier-"); await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({directory, ...report}));
