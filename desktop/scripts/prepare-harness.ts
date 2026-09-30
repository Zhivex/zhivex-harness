import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Explicit developer setup. Build/package never fetch a candidate or use source aliases.
const root = path.resolve(import.meta.dir, "..");
const artifact = process.argv[2];
if (!artifact) throw new Error("Pass an existing Harness candidate tarball.");
const bytes = await readFile(path.resolve(artifact));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const managed = path.join(root, ".harness");
const install = path.join(managed, sha256);
await mkdir(install, { recursive: true });
await copyFile(path.resolve(artifact), path.join(install, "harness.tgz"));
await writeFile(path.join(install, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@zhivex-ai/harness": "file:./harness.tgz" } }));
const command = Bun.spawn(["bun", "install", "--ignore-scripts"], { cwd: install, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
if (code) throw new Error(`Candidate installation failed (${code}).\n${stdout}\n${stderr}`);
const packageRoot = path.join(install, "node_modules/@zhivex-ai/harness");
const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
if (metadata.name !== "@zhivex-ai/harness") throw new Error("Candidate package identity mismatch.");
const desktop = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (metadata.version !== desktop.harness?.version) throw new Error("Candidate version does not match Desktop's exact Harness dependency.");
for (const subpath of ["./engine", "./protocol", "./service", "./models", "./desktop/v1/state", "./desktop/v1/providers"]) {
  const entry = metadata.exports?.[subpath];
  if (!entry?.import || !entry?.types) throw new Error(`Candidate is missing ${subpath}. Published RC3 predates the Desktop contracts; use the local candidate.`);
  await access(path.join(packageRoot, entry.import)); await access(path.join(packageRoot, entry.types));
}
const link = path.join(root, "node_modules/@zhivex-ai/harness");
await mkdir(path.dirname(link), { recursive: true });
try {
  if (!(await lstat(link)).isSymbolicLink() || !path.resolve(path.dirname(link), await readlink(link)).startsWith(managed + path.sep)) {
    const existing = JSON.parse(await readFile(path.join(link, "package.json"), "utf8"));
    if (existing.name !== "@zhivex-ai/harness") throw new Error("Refusing to replace an unrelated dependency path.");
    // Explicit setup may replace a registry install, but preserves it for recovery.
    await rename(link, path.join(managed, `previous-${randomUUID()}`));
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const temporary = `${link}.${process.pid}.tmp`;
await symlink(path.relative(path.dirname(link), packageRoot), temporary, "dir");
await rename(temporary, link);
await writeFile(path.join(managed, "installed.json"), JSON.stringify({ schemaVersion: 1, sha256, version: metadata.version, install }, null, 2) + "\n");
console.log(`Desktop uses installed Harness ${metadata.version}, SHA-256 ${sha256}.`);
