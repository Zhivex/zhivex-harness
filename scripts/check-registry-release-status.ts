import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

interface PackageManifest {
  name: string;
  version: string;
}

interface RegistryDocument {
  versions?: Record<string, { dist?: { integrity?: string } }>;
}

const workspace = path.resolve(import.meta.dir, "..");
const artifactArgument = process.argv[2];
if (!artifactArgument) {
  throw new Error("Usage: bun run release:status -- <package.tgz>");
}
const artifact = path.resolve(process.cwd(), artifactArgument);
assert((await stat(artifact)).isFile(), `${artifact} is not a regular file`);
const manifest = JSON.parse(
  await readFile(path.join(workspace, "package.json"), "utf8")
) as PackageManifest;
const bytes = await readFile(artifact);
const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`, {
  headers: { accept: "application/json", "cache-control": "no-cache" },
  signal: AbortSignal.timeout(15_000)
});
if (response.status === 404) {
  process.stdout.write("absent\n");
  process.exit(0);
}
if (!response.ok) {
  throw new Error(`npm registry status request failed with HTTP ${response.status}`);
}
const registry = await response.json() as RegistryDocument;
const existing = registry.versions?.[manifest.version];
if (!existing) {
  process.stdout.write("absent\n");
  process.exit(0);
}
assert.equal(
  existing.dist?.integrity,
  expectedIntegrity,
  `${manifest.name}@${manifest.version} exists with different immutable bytes`
);
process.stdout.write("identical\n");
