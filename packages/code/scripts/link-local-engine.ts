import { access, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Explicit contributor setup only. Never runs at install, pack, or build time.
const codeRoot = fileURLToPath(new URL("../", import.meta.url));
const harnessRoot = path.resolve(codeRoot, "../..");
const manifest = JSON.parse(await readFile(path.join(harnessRoot, "package.json"), "utf8"));
if (manifest.name !== "@zhivex-ai/harness") throw new Error("Run local setup from the Harness monorepo checkout.");
for (const subpath of ["./engine", "./client", "./code-support"]) {
  const entry = manifest.exports?.[subpath];
  if (!entry?.import || !entry?.types) throw new Error(`Harness has no built public ${subpath} export. Build Harness first.`);
  for (const file of [entry.import, entry.types]) await access(path.join(harnessRoot, file));
}
const link = path.join(codeRoot, "node_modules/@zhivex-ai/harness");
try {
  await lstat(link);
  if (await realpath(link) === await realpath(harnessRoot)) {
    console.log("Local Code already consumes the built Harness checkout.");
  } else {
    console.log("Preserving the existing Code Harness dependency; local link was not created.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  // A dangling existing symlink is preserved too: never overwrite user installs.
  try { await lstat(link); throw new Error("Existing Harness link is dangling; inspect it before local setup."); }
  catch (existing) { if ((existing as NodeJS.ErrnoException).code !== "ENOENT") throw existing; }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(process.platform === "win32" ? harnessRoot : path.relative(path.dirname(link), harnessRoot), link, process.platform === "win32" ? "junction" : "dir");
  console.log("Code now consumes the built Harness checkout (local development only; registry compatibility is not certified).");
}
