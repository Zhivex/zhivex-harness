import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  publishConfig?: { access?: string; provenance?: boolean; registry?: string };
  bin?: Record<string, string>;
}

const workspace = path.resolve(import.meta.dir, "..");
const artifactArgument = process.argv[2];
if (!artifactArgument) {
  throw new Error("Usage: bun run artifact:check -- <package.tgz>");
}
const artifact = path.resolve(process.cwd(), artifactArgument);
assert((await stat(artifact)).isFile(), `${artifact} is not a regular file`);

const run = async (command: string[]): Promise<CommandResult> => {
  const child = Bun.spawn(command, {
    cwd: workspace,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stdout}\n${stderr}`);
  }
  return { exitCode, stdout, stderr };
};

const archive = await run(["tar", "-tzf", artifact]);
const entries = archive.stdout.split(/\r?\n/).filter(Boolean);
assert(entries.length > 0, "release artifact is empty");
assert.equal(new Set(entries).size, entries.length, "release artifact contains duplicate paths");

const exactAllowed = new Set([
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/ROADMAP.md",
  "package/CHANGELOG.md",
  "package/SECURITY.md",
  "package/SUPPORT.md"
]);
const allowedPrefixes = [
  "package/dist/",
  "package/docs/",
  "package/evaluations/",
  "package/examples/"
];

for (const entry of entries) {
  assert(!entry.startsWith("/"), `release artifact contains absolute path ${entry}`);
  assert(!entry.split("/").includes(".."), `release artifact contains traversal path ${entry}`);
  assert(
    exactAllowed.has(entry) || allowedPrefixes.some((prefix) => entry.startsWith(prefix)),
    `release artifact contains unexpected path ${entry}`
  );
}

for (const required of [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/CHANGELOG.md",
  "package/SECURITY.md",
  "package/SUPPORT.md",
  "package/docs/RELEASE.md",
  "package/docs/EXTENSIBILITY.md",
  "package/evaluations/golden-expectations.json",
  "package/examples/mcp-config.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/cli.js",
  "package/dist/zhx.js",
  "package/dist/hostile-repository-demo.js"
]) {
  assert(entries.includes(required), `release artifact is missing ${required}`);
}

const packedManifestOutput = await run(["tar", "-xOzf", artifact, "package/package.json"]);
const packedManifest = JSON.parse(packedManifestOutput.stdout) as PackageManifest;
const sourceManifest = JSON.parse(
  await readFile(path.join(workspace, "package.json"), "utf8")
) as PackageManifest;
assert.equal(packedManifest.name, sourceManifest.name, "packed package name differs from source");
assert.equal(packedManifest.version, sourceManifest.version, "packed version differs from source");
assert.notEqual(packedManifest.private, true, "packed manifest is private");
assert.deepEqual(
  packedManifest.publishConfig,
  {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/"
  },
  "packed publication policy is incorrect"
);
assert.deepEqual(
  packedManifest.bin,
  { "zhivex-harness": "./dist/cli.js", zhx: "./dist/zhx.js" },
  "packed CLI aliases are incorrect"
);

const bytes = await readFile(artifact);
const sha512Hex = createHash("sha512").update(bytes).digest("hex");
const checksumPath = path.join(path.dirname(artifact), "SHA512SUMS");
await writeFile(checksumPath, `${sha512Hex}  ${path.basename(artifact)}\n`, "utf8");

process.stdout.write(
  `Release artifact passed: ${path.basename(artifact)} (${entries.length} files, sha512 ${sha512Hex.slice(0, 16)}…).\n`
);
