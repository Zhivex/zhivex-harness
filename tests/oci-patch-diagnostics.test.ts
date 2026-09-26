import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHarnessOciExecutionEnvironment, type HarnessOciRuntimeAdapter } from "../src/execution/execution-environment.js";
import { EnvironmentPatchDriftError } from "../src/execution/patch-diagnostics.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { HarnessExecutionError } from "../src/runtime/errors.js";
import { classifyTimeToSafeFixFailure } from "../src/runtime/time-to-safe-fix.js";
import { Workspace } from "../src/workspace/workspace.js";
import { restoreSanitizedOperationalError, sanitizeOperationalError } from "../scripts/release-diagnostics.js";

const runtime: HarnessOciRuntimeAdapter = {
  async inspectImage(imageReference) {
    return { runtime: "docker", runtimeVersion: "fixture", imageReference,
      imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` };
  },
  async run() { throw new Error("These snapshot regressions must not invoke Docker or a provider."); },
  async removeRunContainers() { return 0; },
  async cleanupOrphans() { return 0; }
};

for (const scenario of ["unchanged", "wrong-id", "changed-content", "no-receipt", "legacy-matching", "binding-changed"] as const) {
  test(`OCI inspection survives approval restart and diagnoses ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhx-patch-diagnostic-"));
    try {
      await writeFile(path.join(root, "value.txt"), "before\n");
      const workspace = await Workspace.open(root);
      const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
      if (config.execution.backend !== "oci") throw new Error("Expected OCI");
      const options = { config: config.execution, workspace, stateDirectory: config.stateDirectory, runtime };
      const environment = await createHarnessOciExecutionEnvironment(options);
      const session = await environment.acquire({ runId: "review-resume" });
      await writeFile(path.join(session.workspace.root, "value.txt"), "reviewed\n");
      const inspection = await session.inspectPatch();
      await session.release?.({ status: "waiting_approval" });
      if (scenario === "changed-content") await writeFile(path.join(session.workspace.root, "value.txt"), "changed\n");
      const metadataPath = path.join(path.dirname(session.workspace.root), "environment.json");
      if (scenario === "no-receipt" || scenario === "legacy-matching" || scenario === "binding-changed") {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        if (scenario !== "binding-changed") delete metadata.lastInspectedPatchId;
        else metadata.executionIdentity = "untrusted-other-identity";
        await writeFile(metadataPath, JSON.stringify(metadata));
      }
      // New provider instance: no in-memory inspection survives this boundary.
      const restarted = await createHarnessOciExecutionEnvironment(options);
      if (scenario === "binding-changed") {
        await expect(restarted.acquire({ runId: "review-resume" }).catch(error => { throw sanitizeOperationalError(error); })).rejects.toMatchObject({ diagnosticCode: "OCI_EXECUTION_BINDING_CHANGED" });
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
        return;
      }
      const resumed = await restarted.acquire({ runId: "review-resume" });
      if (scenario === "unchanged" || scenario === "legacy-matching") {
        // Legacy imports remain valid without writing a fresh diagnostic receipt.
        await resumed.importPatch(workspace, inspection.patchId);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("reviewed\n");
      } else {
        const requested = scenario === "changed-content" ? inspection.patchId : `sha256:${"0".repeat(64)}` as const;
        await expect(resumed.importPatch(workspace, requested).catch(error => { throw sanitizeOperationalError(error); })).rejects.toMatchObject({
          diagnosticCode: scenario === "wrong-id" ? "OCI_PATCH_ID_MISMATCH"
            : scenario === "changed-content" ? "OCI_PATCH_SNAPSHOT_CHANGED" : "OCI_PATCH_REVIEW_UNAVAILABLE"
        });
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before\n");
        // Recovery requires a fresh inspection and submission of that exact ID.
        // No rejected request is silently rebound to different bytes.
        const reviewedAgain = await resumed.inspectPatch();
        await resumed.release?.({ status: "waiting_approval" });
        const reapproved = await restarted.acquire({ runId: "review-resume" });
        await reapproved.importPatch(workspace, reviewedAgain.patchId);
        expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe(scenario === "changed-content" ? "changed\n" : "reviewed\n");
        await reapproved.release?.({ status: "completed" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const [expectedDigit, currentDigit, lastDigit, diagnosticCode] of [
  ["a", "b", "a", "OCI_PATCH_SNAPSHOT_CHANGED"],
  ["a", "b", "b", "OCI_PATCH_ID_MISMATCH"],
  ["a", "b", "c", "OCI_PATCH_REVIEW_UNAVAILABLE"]
] as const) {
  test(`sanitized child-process round trip preserves ${diagnosticCode} without patch data`, () => {
    const expected = `sha256:${expectedDigit.repeat(64)}` as const;
    const current = `sha256:${currentDigit.repeat(64)}` as const;
    const error = new HarnessExecutionError("PRIVATE_CONTENT", {
      cause: new EnvironmentPatchDriftError(expected, current, `sha256:${lastDigit.repeat(64)}`)
    });
    const projection = sanitizeOperationalError(error);
    expect(projection.diagnosticCode).toBe(diagnosticCode);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("PRIVATE_CONTENT");
    expect(serialized).not.toContain(expected);
    expect(serialized).not.toContain(current);
    const restored = restoreSanitizedOperationalError(JSON.parse(serialized));
    expect(classifyTimeToSafeFixFailure(restored)).toMatchObject({ code: "PATCH_DRIFT", diagnosticCode, retryable: false });
  });
}
