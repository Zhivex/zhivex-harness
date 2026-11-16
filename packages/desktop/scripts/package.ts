import { createRequire } from "node:module";
import { packager } from "@electron/packager";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { installedHarness } from "./installed-harness.js";
const root = path.resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const keyringRequire = createRequire(require.resolve("@napi-rs/keyring"));
const nativePackage = (name: string) => path.dirname(keyringRequire.resolve(`@napi-rs/${name}/package.json`));
const meta = await Bun.file(path.join(root, "package.json")).json();
const candidate = await installedHarness(root);
const built = await Bun.file(path.join(root, "build/runtime-metadata.json")).json();
if (built.harnessArtifactSha256 !== candidate.sha256) throw new Error("Build and package Harness candidates differ. Rebuild Desktop first.");
const stage = await mkdtemp("/tmp/zhx-desktop-package-");
try {
    await cp(path.join(root, "build"), path.join(stage, "build"), { recursive: true });
    for (const name of ["keyring", "keyring-darwin-arm64"]) await cp(nativePackage(name), path.join(stage, "node_modules/@napi-rs", name), {recursive: true, dereference: true});
    await writeFile(path.join(stage, "package.json"), JSON.stringify({ name: meta.name, version: meta.version, main: meta.main, private: true }));
    const results = await packager({ dir: stage, out: path.join(root, "out"), name: "Zhivex Harness", icon: path.join(root, "assets/zhivex-logo.icns"), appBundleId: "ai.zhivex.harness", appVersion: meta.version.split(/[+-]/)[0], buildVersion: meta.version.split(/[+-]/)[0], extendInfo: {ZhivexDesktopVersion: meta.version}, platform: "darwin", arch: "arm64", electronVersion: meta.devDependencies.electron, ...(process.env.ELECTRON_ZIP_DIR ? {electronZipDir: process.env.ELECTRON_ZIP_DIR} : {}), overwrite: true, asar: {unpack: "**/*.node"}, extraResource:[path.join(root,"build/credential-runtime"),path.join(root,"build/credential-store"),path.join(root,"build/update-worker-lock"),path.join(root,"build/update-worker-entry.cjs")], prune: false });
    console.log(results.join("\n"));
} finally { await rm(stage, { recursive: true, force: true }); }
