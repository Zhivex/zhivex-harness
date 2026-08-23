import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadTimeToSafeFixHarnessRuntime } from "../scripts/time-to-safe-fix-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const artifactRuntimeFixture = async (version = "1.0.0-rc.1") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-artifact-runtime-"));
  temporaryDirectories.push(directory);
  const modulePath = path.join(directory, "index.mjs");
  await writeFile(modulePath, [
    `export const HARNESS_VERSION = ${JSON.stringify(version)};`,
    "export const classifyTimeToSafeFixFailure = () => ({ code: 'artifact-classifier' });",
    "export const createHarness = () => 'artifact-runtime';",
    "export const createProviderModel = () => 'artifact-model';",
    "export const harnessExecutionSession = () => undefined;",
    "export const resolveHarnessConfig = () => ({ source: 'artifact' });",
    "export const runHarness = () => 'artifact-run';",
    "export const timeToSafeFixDriverResultSchema = { parse: (value) => value };"
  ].join("\n"));
  return modulePath;
};

describe("Time-to-Safe-Fix artifact runtime", () => {
  test("loads the explicitly selected artifact module and validates its release version", async () => {
    const modulePath = await artifactRuntimeFixture();
    const runtime = await loadTimeToSafeFixHarnessRuntime({
      ZHIVEX_SAFE_FIX_HARNESS_RUNTIME: modulePath,
      RELEASE_TAG: "v1.0.0-rc.1"
    });

    expect(runtime.HARNESS_VERSION).toBe("1.0.0-rc.1");
    expect((runtime.createHarness as unknown as () => string)()).toBe("artifact-runtime");
    expect((runtime.resolveHarnessConfig as unknown as () => { source: string })()).toEqual({
      source: "artifact"
    });
  });

  test("fails closed when the selected artifact is missing exports or differs from RELEASE_TAG", async () => {
    const wrongVersion = await artifactRuntimeFixture("1.0.0-rc.2");
    await expect(loadTimeToSafeFixHarnessRuntime({
      ZHIVEX_SAFE_FIX_HARNESS_RUNTIME: wrongVersion,
      RELEASE_TAG: "v1.0.0-rc.1"
    })).rejects.toThrow("version differs from RELEASE_TAG");

    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-incomplete-runtime-"));
    temporaryDirectories.push(directory);
    const incomplete = path.join(directory, "index.mjs");
    await writeFile(incomplete, "export const HARNESS_VERSION = '1.0.0-rc.1';\n");
    await expect(loadTimeToSafeFixHarnessRuntime({
      ZHIVEX_SAFE_FIX_HARNESS_RUNTIME: incomplete,
      RELEASE_TAG: "v1.0.0-rc.1"
    })).rejects.toThrow("missing function export");
  });
});
