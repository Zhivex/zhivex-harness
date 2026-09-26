import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type HarnessRuntime = typeof import("../src/index.js");
const functions = ["createHarness", "runHarness", "providerDescriptor", "parseProvider",
  "createEditProposal", "inspectHarnessRun", "createHarnessRouteModels", "resolveHarnessModelRoutes",
  "HarnessConfigError", "HarnessExecutionError"] as const;

/** Release callers must select the inspected tarball; local development may use source. */
export const loadLiveSmokeRuntime = async (env: NodeJS.ProcessEnv = process.env): Promise<HarnessRuntime> => {
  const requested = env.ZHIVEX_HARNESS_LIVE_RUNTIME?.trim();
  if (!requested) {
    assert(env.ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT !== "1", "Live release certification requires an artifact runtime");
    return import("../src/index.js");
  }
  assert(path.isAbsolute(requested), "Live artifact runtime must be an absolute path");
  const entry = await lstat(requested);
  assert(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, "Live artifact runtime must be a regular non-symlink file");
  const tag = env.RELEASE_TAG?.trim();
  assert(tag && /^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(tag), "Live artifact runtime requires a canonical release tag");
  const runtime = await import(pathToFileURL(await realpath(requested)).href) as HarnessRuntime;
  assert.equal(runtime.HARNESS_VERSION, tag.slice(1), "Live artifact version differs from release tag");
  for (const name of functions) assert.equal(typeof runtime[name], "function", `Live artifact is missing ${name}`);
  assert(Array.isArray(runtime.PROVIDERS) && Array.isArray(runtime.PROVIDER_DESCRIPTORS), "Live artifact is missing provider descriptors");
  return runtime;
};
