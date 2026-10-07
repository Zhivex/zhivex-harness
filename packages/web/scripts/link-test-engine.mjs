import { access, lstat, mkdir, readFile, realpath, rename, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit offline test setup only. Product install/build never invokes this.
const web = fileURLToPath(new URL("../", import.meta.url));
const engine = path.resolve(web, "../..");
const manifest = JSON.parse(await readFile(path.join(engine, "package.json"), "utf8"));
if (manifest.name !== "@zhivex-ai/harness") throw Error("Web tests require the Harness checkout.");
for (const subpath of ["./engine", "./protocol", "./service", "./code-support", "./desktop/v1/state"]) {
  const entry = manifest.exports[subpath];
  if (!entry?.import || !entry?.types) throw Error(`Missing built public export ${subpath}.`);
  await access(path.join(engine, entry.import));
  await access(path.join(engine, entry.types));
}
const link = path.join(web, "node_modules/@zhivex-ai/harness");
let existing;
try { existing = await lstat(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing?.isSymbolicLink()) {
  if (await realpath(link) !== await realpath(engine)) throw Error("Refusing to replace another checkout's Harness link.");
} else {
  if (existing) {
    const previous = JSON.parse(await readFile(path.join(link, "package.json"), "utf8"));
    if (previous.name !== manifest.name) throw Error("Refusing to replace an unrelated dependency.");
    const backup = path.join(web, ".test-output");
    await mkdir(backup, { recursive: true });
    await rename(link, path.join(backup, `harness-registry-${randomUUID()}`));
  }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(process.platform === "win32" ? engine : path.relative(path.dirname(link), engine), link, process.platform === "win32" ? "junction" : "dir");
}
console.log(`Web offline tests use built Harness ${manifest.version} from this checkout.`);
