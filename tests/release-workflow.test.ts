import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const workspace = path.resolve(import.meta.dir, "..");
const workflowPaths = [
  ".github/workflows/release.yml",
  ".github/workflows/live-certification.yml"
] as const;

describe("release workflow version source", () => {
  for (const workflowPath of workflowPaths) {
    test(`${workflowPath} requires a tag without duplicating the package version`, async () => {
      const workflow = await readFile(path.join(workspace, workflowPath), "utf8");

      expect(workflow).toContain(
        "description: Annotated vX.Y.Z or vX.Y.Z-rc.N tag; must match package.json and resolve to main"
      );
      expect(workflow).toContain("required: true");
      expect(workflow).toContain("ref: ${{ inputs.tag }}");
      expect(workflow).not.toMatch(/default:\s+v\d+\.\d+\.\d+/);
    });
  }

  test("CI verifies the built version against package.json without a duplicate literal", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('const expected = require("./package.json").version');
    expect(workflow).not.toMatch(/HARNESS_VERSION !== "\d+\.\d+\.\d+"/);
  });

  test("release artifact transfer actions are pinned to immutable commit SHAs", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toMatch(/actions\/upload-artifact@[a-f0-9]{40}(?:\s|$)/);
    expect(workflow).toMatch(/actions\/download-artifact@[a-f0-9]{40}(?:\s|$)/);
  });

  test("release validation binds stable and prerelease versions to the correct npm channel", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('--channel "$RELEASE_CHANNEL"');
    expect(workflow).toContain("RELEASE_CHANNEL: ${{ inputs.channel }}");
  });

  test("release validation can verify recorded GitHub workflow evidence", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });

  test("release readiness invokes the fail-closed GA promotion gate for 1.0.0", async () => {
    const readiness = await readFile(path.join(workspace, "scripts/check-release-readiness.ts"), "utf8");

    expect(readiness).toContain('manifest.version === "1.0.0"');
    expect(readiness).toContain('["bun", "run", "readiness:1.0:release"]');
  });

  test("publication requires complete sanitized representative evidence", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("representative-evaluation:");
    expect(workflow).toContain("- representative-evaluation");
    expect(workflow).toContain("needs.representative-evaluation.result == 'success'");
    expect(workflow).toContain("evaluations/representative-repositories.jsonl");
    expect(workflow).toContain("--tasks 7 --repetitions 1 --profiles governed --carriers rule_file");
    expect(workflow).toContain("--provider meta --model muse-spark-1.2");
    expect(workflow).toContain("--provider qwen --model qwen3.8-max");
    expect(workflow).toContain("--provider openai --model gpt-5.6-luna");
    expect(workflow).toContain("scripts/assemble-representative-evidence.ts");
    expect(workflow).toContain("path: release-artifacts/representative-evidence-*.json");
    expect(workflow).not.toContain("path: release-artifacts/representative-raw");
  });

  test("representative evaluation loads the exact unpacked artifact runtime", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('tar -xzf "$ARTIFACT" -C "$RUNTIME_ROOT"');
    expect(workflow).toContain('RUNTIME_MODULE="$RUNTIME_ROOT/package/dist/index.js"');
    expect(workflow).toContain('test "$RUNTIME_VERSION" = "${RELEASE_TAG#v}"');
    expect(workflow).toContain('echo "ZHIVEX_SAFE_FIX_HARNESS_RUNTIME=$RUNTIME_MODULE" >> "$GITHUB_ENV"');
    expect(workflow).toContain("scripts/time-to-safe-fix-runtime.ts");
  });

  test("executes the workflow SHA-512 expression against its first Bun argument", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");
    const expression = workflow.match(/ARTIFACT_SHA512="\$\(bun -e '([^']+)' "\$ARTIFACT"\)"/)?.[1];
    expect(expression).toContain("process.argv[1]");
    expect(expression).not.toContain("process.argv[2]");

    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-release-integrity-"));
    try {
      const artifact = path.join(directory, "artifact.tgz");
      const bytes = Buffer.from("exact release artifact fixture\n");
      await writeFile(artifact, bytes);
      const child = Bun.spawn(["bun", "-e", expression!, artifact], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
