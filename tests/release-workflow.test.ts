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
        "description: Annotated vX.Y.Z tag; must match package.json and resolve to main"
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
});
