import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLiveSmokeRuntime } from "../scripts/live-smoke-runtime.js";

const functions = ["createHarness", "runHarness", "providerDescriptor", "parseProvider", "createEditProposal",
  "inspectHarnessRun", "createHarnessRouteModels", "resolveHarnessModelRoutes", "HarnessConfigError", "HarnessExecutionError"];

test("release live runtime cannot silently fall back to source", async () => {
  await expect(loadLiveSmokeRuntime({ ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT: "1" })).rejects.toThrow("requires an artifact");
  await expect(loadLiveSmokeRuntime({ ZHIVEX_HARNESS_LIVE_RUNTIME: "dist/index.js" })).rejects.toThrow("absolute");
});

test("live runtime loads selected artifact functions and rejects wrong versions, links and incomplete exports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhx-live-artifact-"));
  try {
    const runtime = path.join(root, "runtime.mjs");
    await writeFile(runtime, 'export const HARNESS_VERSION="1.2.0-rc.1", PROVIDERS=[], PROVIDER_DESCRIPTORS=[];\n' +
      functions.map(name => `export function ${name}(){return "artifact-only";}`).join("\n"));
    const env = { ZHIVEX_HARNESS_LIVE_RUNTIME: runtime, RELEASE_TAG: "v1.2.0-rc.1" };
    const loaded = await loadLiveSmokeRuntime(env);
    expect((loaded.createEditProposal as unknown as () => string)()).toBe("artifact-only");
    await expect(loadLiveSmokeRuntime({ ...env, RELEASE_TAG: "v1.2.0-rc.2" })).rejects.toThrow("differs");
    await expect(loadLiveSmokeRuntime({ ...env, RELEASE_TAG: "" })).rejects.toThrow("canonical");
    const link = path.join(root, "link.mjs");
    await symlink(runtime, link);
    await expect(loadLiveSmokeRuntime({ ...env, ZHIVEX_HARNESS_LIVE_RUNTIME: link })).rejects.toThrow("regular");
    const missing = path.join(root, "missing.mjs");
    await writeFile(missing, 'export const HARNESS_VERSION="1.2.0-rc.1";');
    await expect(loadLiveSmokeRuntime({ ...env, ZHIVEX_HARNESS_LIVE_RUNTIME: missing })).rejects.toThrow("missing createHarness");
  } finally { await rm(root, { recursive: true, force: true }); }
});
