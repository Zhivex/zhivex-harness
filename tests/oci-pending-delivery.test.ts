import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHarnessOciExecutionEnvironment, type HarnessOciRuntimeAdapter } from "../src/execution/execution-environment.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { Workspace } from "../src/workspace/workspace.js";

const runtime: HarnessOciRuntimeAdapter = {
  async inspectImage(imageReference) {
    return { runtime: "docker", runtimeVersion: "fixture", imageReference,
      imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` };
  },
  async run() { throw new Error("No container should execute during delivery inspection."); },
  async removeRunContainers() { return 0; },
  async cleanupOrphans() { return 0; }
};

for (const operation of ["update", "create", "delete", "mode"] as const) {
  test(`OCI ${operation} delivery is inspected read-only and survives restart`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhx-pending-"));
    try {
      if (operation !== "create") await writeFile(path.join(root, "value.txt"), "before\n");
      const workspace = await Workspace.open(root);
      const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
      if (config.execution.backend !== "oci") throw new Error("Expected OCI");
      const options = { config: config.execution, workspace, stateDirectory: config.stateDirectory, runtime };
      const environment = await createHarnessOciExecutionEnvironment(options);
      const request = { runId: "pending-run", scope: { tenantId: "tenant" } };
      expect(await environment.pendingDelivery!(request)).toBe(false);
      const session = await environment.acquire(request);
      const target = path.join(session.workspace.root, "value.txt");
      const initialMode = operation === "create" ? undefined : (await session.workspace.inspectFile("value.txt")).mode;
      if (operation === "delete") await rm(target);
      else if (operation === "mode") await chmod(target, 0o755);
      else await writeFile(target, "after\n");
      const metadataPath = path.join(path.dirname(session.workspace.root), "environment.json");
      const metadata = await readFile(metadataPath, "utf8");
      expect(await environment.pendingDelivery!(request)).toBe(true);
      expect(await readFile(metadataPath, "utf8")).toBe(metadata);
      expect(await environment.pendingDelivery!({ ...request, scope: { tenantId: "different" } })).toBe(false);
      const restarted = await createHarnessOciExecutionEnvironment(options);
      expect(await restarted.pendingDelivery!(request)).toBe(true);
      const patch = await session.inspectPatch();
      await session.importPatch(workspace, patch.patchId);
      expect(await restarted.pendingDelivery!(request)).toBe(false);
      // Returning exactly to the original base hides this path from the diff,
      // but does not undo the already imported host edit.
      if (operation === "create") await rm(target);
      else if (operation === "mode") await chmod(target, initialMode!);
      else await writeFile(target, "before\n");
      expect((await session.inspectPatch()).entries).toHaveLength(0);
      expect(await restarted.pendingDelivery!(request)).toBe(true);
      const history = JSON.parse(await readFile(metadataPath, "utf8"));
      expect(history.deliveryPaths).toEqual(["value.txt"]);
      history.deliveryPaths = ["../outside"];
      await writeFile(metadataPath, JSON.stringify(history));
      await expect(restarted.pendingDelivery!(request)).rejects.toThrow("Invalid or oversized");
      await rm(metadataPath);
      await expect(restarted.pendingDelivery!(request)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("an import exception after effects keeps delivery obligations through base reversion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-pending-failure-"));
  try {
    await writeFile(path.join(root, "value.txt"), "before\n");
    const workspace = await Workspace.open(root);
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI");
    const environment = await createHarnessOciExecutionEnvironment({ config: config.execution, workspace,
      stateDirectory: config.stateDirectory, runtime });
    const request = { runId: "partial-import" };
    const session = await environment.acquire(request);
    const target = path.join(session.workspace.root, "value.txt");
    await writeFile(target, "after\n");
    const patch = await session.inspectPatch();
    const apply = workspace.applyPatchWithModes.bind(workspace);
    workspace.applyPatchWithModes = async (...args) => {
      await apply(...args);
      throw new Error("injected failure after writing host");
    };
    await expect(session.importPatch(workspace, patch.patchId)).rejects.toThrow("injected failure");
    expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after\n");
    await writeFile(target, "before\n");
    expect((await session.inspectPatch()).entries).toHaveLength(0);
    expect(await environment.pendingDelivery!(request)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
