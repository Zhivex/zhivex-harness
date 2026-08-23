import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type HarnessPublicModule = typeof import("../src/index.js");

export type TimeToSafeFixHarnessRuntime = Pick<
  HarnessPublicModule,
  | "HARNESS_VERSION"
  | "classifyTimeToSafeFixFailure"
  | "createHarness"
  | "createProviderModel"
  | "harnessExecutionSession"
  | "resolveHarnessConfig"
  | "runHarness"
  | "timeToSafeFixDriverResultSchema"
>;

const REQUIRED_RUNTIME_FUNCTIONS = [
  "classifyTimeToSafeFixFailure",
  "createHarness",
  "createProviderModel",
  "harnessExecutionSession",
  "resolveHarnessConfig",
  "runHarness"
] as const satisfies readonly (keyof TimeToSafeFixHarnessRuntime)[];

const validateRuntime = (
  input: unknown,
  expectedVersion?: string
): TimeToSafeFixHarnessRuntime => {
  assert(input && typeof input === "object", "Harness runtime module must export an object");
  const runtime = input as Record<string, unknown>;
  for (const name of REQUIRED_RUNTIME_FUNCTIONS) {
    assert.equal(typeof runtime[name], "function", `Harness runtime is missing function export ${name}`);
  }
  assert(
    runtime.timeToSafeFixDriverResultSchema &&
      typeof runtime.timeToSafeFixDriverResultSchema === "object" &&
      typeof (runtime.timeToSafeFixDriverResultSchema as { parse?: unknown }).parse === "function",
    "Harness runtime is missing timeToSafeFixDriverResultSchema"
  );
  assert.equal(typeof runtime.HARNESS_VERSION, "string", "Harness runtime is missing HARNESS_VERSION");
  if (expectedVersion !== undefined) {
    assert.equal(
      runtime.HARNESS_VERSION,
      expectedVersion,
      "Installed Harness runtime version differs from RELEASE_TAG"
    );
  }
  return runtime as unknown as TimeToSafeFixHarnessRuntime;
};

/**
 * Resolve the runtime used by the autonomous driver. Release evaluation sets an
 * absolute module path extracted from the validated tarball; local runs fall
 * back to the checkout implementation.
 */
export const loadTimeToSafeFixHarnessRuntime = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<TimeToSafeFixHarnessRuntime> => {
  const requestedModule = env.ZHIVEX_SAFE_FIX_HARNESS_RUNTIME?.trim();
  if (!requestedModule) return validateRuntime(await import("../src/index.js"));

  assert(path.isAbsolute(requestedModule), "ZHIVEX_SAFE_FIX_HARNESS_RUNTIME must be an absolute path");
  const suppliedEntry = await lstat(requestedModule);
  assert(
    suppliedEntry.isFile() && !suppliedEntry.isSymbolicLink() && suppliedEntry.nlink === 1,
    "ZHIVEX_SAFE_FIX_HARNESS_RUNTIME must be one regular non-symlink file"
  );
  const canonicalModule = await realpath(requestedModule);
  const releaseTag = env.RELEASE_TAG?.trim();
  assert(
    releaseTag && /^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(releaseTag),
    "Artifact runtime requires a canonical RELEASE_TAG"
  );
  return validateRuntime(
    await import(pathToFileURL(canonicalModule).href),
    releaseTag.slice(1)
  );
};
