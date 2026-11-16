import { createRequire } from "node:module";
import { rm, mkdir, copyFile, cp } from "node:fs/promises";
import path from "node:path";
import {parseDesktopUpdateTrust} from "../src/update-trust.js";
import { installedHarness } from "./installed-harness.js";
const root = path.resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const keyringRequire = createRequire(require.resolve("@napi-rs/keyring"));
const nativePackage = (name: string) => path.dirname(keyringRequire.resolve(`@napi-rs/${name}/package.json`));
parseDesktopUpdateTrust(await Bun.file(path.join(root, "update-trust.json")).json());
const outdir = path.join(root, "build"); await rm(outdir, { recursive: true, force: true }); await mkdir(outdir);
const candidate = await installedHarness(root);
const metadata = candidate.metadata;
for (const name of ["update-worker-entry"]) {
    const result = await Bun.build({ entrypoints: [path.join(root, `src/${name}.ts`)], outdir, target: "node", format: "cjs", naming: `${name}.cjs`, external: ["electron"], define: { "process.env.NODE_ENV": JSON.stringify("production") } });
    if (!result.success) throw new AggregateError(result.logs, `Build ${name} failed`);
}
await copyFile(path.join(root, "assets/zhivex-logo.png"), path.join(outdir, "zhivex-logo.png"));
console.log("Desktop bundles built with Bun.");

if(process.platform==="darwin")await import("./build-credential-helper.js");
if(process.platform==="darwin")await import("./build-update-worker-lock.js");

const desktopMetadata=await Bun.file(path.join(root,"package.json")).json();
await Bun.write(path.join(outdir,"runtime-metadata.json"),JSON.stringify({desktopVersion:desktopMetadata.version,harnessVersion:metadata.version,harnessArtifactSha256:candidate.sha256,electronVersion:desktopMetadata.devDependencies.electron}));

for (const name of ["main", "preload", "assistant-worker"]) {
  const result = await Bun.build({entrypoints: [path.join(root, `src/unified/${name}.ts`)], outdir, target: "node", format: "cjs", naming: `unified-${name}.cjs`, external: ["electron", "@napi-rs/keyring"], define: {"process.env.NODE_ENV": JSON.stringify("production")}});
  if (!result.success) throw new AggregateError(result.logs, `Unified ${name} build failed`);
}
const unified = await Bun.build({entrypoints: [path.join(root, "src/unified/renderer.tsx")], outdir, target: "browser", format: "esm", naming: "unified-renderer.[ext]", minify: true, define: {"process.env.NODE_ENV": JSON.stringify("production")}});
if (!unified.success) throw new AggregateError(unified.logs, "Unified renderer build failed");
await copyFile(path.join(root, "src/unified/index.html"), path.join(outdir, "unified.html"));

for (const name of ["statusTemplate.png", "statusTemplate@2x.png"]) await copyFile(path.join(root, "assets", name), path.join(outdir, name));

const credentialRuntime = path.join(outdir, 'credential-runtime');
await mkdir(credentialRuntime, {recursive: true});
const credentialBuild = await Bun.build({entrypoints: [path.join(root, 'src/unified/credential-worker.ts')], outdir: credentialRuntime, target: 'node', format: 'cjs', naming: 'worker.cjs', external: ['@napi-rs/keyring']});
if (!credentialBuild.success) throw new AggregateError(credentialBuild.logs, 'Credential worker build failed');
for (const name of ['keyring', 'keyring-darwin-arm64']) await cp(nativePackage(name), path.join(credentialRuntime, 'node_modules/@napi-rs', name), {recursive: true, dereference: true});
