import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

import { readRegularFileNoFollow } from "../src/file-security.js";

interface PackageManifest {
  name: string;
  version: string;
}

interface RegistryDocument {
  versions?: Record<string, { dist?: { integrity?: string } }>;
}

const workspace = path.resolve(import.meta.dir, "..");
const PACKAGE_NAME = "@zhivex-ai/harness";
const PACKAGE_REGISTRY_URL = "https://registry.npmjs.org/%40zhivex-ai%2Fharness";
const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const artifactArgument = process.argv[2];
if (!artifactArgument) {
  throw new Error("Usage: bun run release:status -- <package.tgz>");
}
const artifact = path.resolve(process.cwd(), artifactArgument);
const manifest = JSON.parse(
  (await readRegularFileNoFollow(path.join(workspace, "package.json"), {
    label: "Release package.json",
    maxBytes: 1024 * 1024
  })).contents.toString("utf8")
) as PackageManifest;
assert.equal(manifest.name, PACKAGE_NAME, "release package name is unexpected");
const bytes = (await readRegularFileNoFollow(artifact, {
  label: "Release artifact",
  maxBytes: MAX_RELEASE_ARTIFACT_BYTES
})).contents;
const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const response = await fetch(PACKAGE_REGISTRY_URL, {
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
