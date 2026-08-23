import { readFile } from "node:fs/promises";
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

  test("release readiness invokes the fail-closed GA promotion gate for 1.0.0", async () => {
    const readiness = await readFile(path.join(workspace, "scripts/check-release-readiness.ts"), "utf8");

    expect(readiness).toContain('manifest.version === "1.0.0"');
    expect(readiness).toContain('["bun", "run", "readiness:1.0:release"]');
  });
});
