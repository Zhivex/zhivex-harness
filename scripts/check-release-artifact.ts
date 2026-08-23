import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readRegularFileNoFollow } from "../src/file-security.js";

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
  engines?: { node?: string; bun?: string };
}

const workspace = path.resolve(import.meta.dir, "..");
const artifactArgument = process.argv[2];
if (!artifactArgument) {
  throw new Error("Usage: bun run artifact:check -- <package.tgz>");
}
const sourceArtifact = path.resolve(process.cwd(), artifactArgument);
const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;

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

const inspectArtifact = async () => {
  const artifactBytes = (await readRegularFileNoFollow(sourceArtifact, {
    label: "Release artifact",
    maxBytes: MAX_RELEASE_ARTIFACT_BYTES
  })).contents;
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-artifact-"));
  try {
    const artifact = path.join(stagingDirectory, "package.tgz");
    await writeFile(artifact, artifactBytes, { flag: "wx", mode: 0o600 });

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
      "package/contracts/",
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
      "package/contracts/public-api.json",
      "package/contracts/security-controls.json",
      "package/docs/EXTENSIBILITY.md",
      "package/docs/CONTEXT_ENGINEERING.md",
      "package/docs/CHANGE_ENVELOPES.md",
      "package/evaluations/golden-expectations.json",
      "package/examples/mcp-config.json",
      "package/examples/change-envelope-input.json",
      "package/examples/change.patch",
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
      (await readRegularFileNoFollow(path.join(workspace, "package.json"), {
        label: "Release package.json",
        maxBytes: 1024 * 1024
      })).contents.toString("utf8")
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
    assert.deepEqual(
      packedManifest.engines,
      { node: ">=22.13.0", bun: ">=1.4.0" },
      "packed runtime compatibility is incorrect"
    );

    const packedCli = (await run(["tar", "-xOzf", artifact, "package/dist/cli.js"])).stdout;
    assert(packedCli.startsWith("#!/usr/bin/env node\n"), "packed CLI does not use the Node shebang");
    const packedRuntimeEntries = entries.filter((entry) =>
      entry.startsWith("package/dist/") && entry.endsWith(".js")
    );
    for (const entry of packedRuntimeEntries) {
      const source = (await run(["tar", "-xOzf", artifact, entry])).stdout;
      assert(
        !/(?:from\s*|require\(|import\()["']bun:/.test(source),
        `packed runtime ${entry} still imports a bun: module`
      );
      assert(!/\bBun\./.test(source), `packed runtime ${entry} still requires a Bun global`);
      assert(!source.startsWith("#!/usr/bin/env bun\n"), `packed runtime ${entry} uses a Bun shebang`);
    }

    const sha512Hex = createHash("sha512").update(artifactBytes).digest("hex");
    const checksumPath = path.join(path.dirname(sourceArtifact), "SHA512SUMS");
    await writeFile(checksumPath, `${sha512Hex}  ${path.basename(sourceArtifact)}\n`, "utf8");

    process.stdout.write(
      `Release artifact passed: ${path.basename(sourceArtifact)} (${entries.length} files, sha512 ${sha512Hex.slice(0, 16)}…).\n`
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
};

await inspectArtifact();
