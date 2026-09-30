import { rm, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import {parseDesktopUpdateTrust} from "../src/update-trust.js";
import { installedHarness } from "./installed-harness.js";
const root = path.resolve(import.meta.dir, "..");
parseDesktopUpdateTrust(await Bun.file(path.join(root, "update-trust.json")).json());
const outdir = path.join(root, "build"); await rm(outdir, { recursive: true, force: true }); await mkdir(outdir);
const candidate = await installedHarness(root);
const metadata = candidate.metadata;
for (const name of ["main", "preload", "runtime", "update-worker-entry"]) {
    const result = await Bun.build({ entrypoints: [path.join(root, `src/${name}.ts`)], outdir, target: "node", format: "cjs", naming: `${name}.cjs`, external: ["electron"], define: { "process.env.NODE_ENV": JSON.stringify("production") } });
    if (!result.success) throw new AggregateError(result.logs, `Build ${name} failed`);
}
const renderer = await Bun.build({ entrypoints: [path.join(root, "src/renderer.tsx")], outdir, target: "browser", format: "esm", define: { "process.env.NODE_ENV": JSON.stringify("production") }, minify: true });
if (!renderer.success) throw new AggregateError(renderer.logs, "Renderer build failed");
await copyFile(path.join(root, "src/index.html"), path.join(outdir, "index.html"));
await copyFile(path.join(root, "assets/zhivex-logo.png"), path.join(outdir, "zhivex-logo.png"));
console.log("Desktop bundles built with Bun.");

if(process.platform==="darwin")await import("./build-credential-helper.js");
if(process.platform==="darwin")await import("./build-update-worker-lock.js");

const desktopMetadata=await Bun.file(path.join(root,"package.json")).json();
await Bun.write(path.join(outdir,"runtime-metadata.json"),JSON.stringify({desktopVersion:desktopMetadata.version,harnessVersion:metadata.version,harnessArtifactSha256:candidate.sha256,electronVersion:desktopMetadata.devDependencies.electron}));
