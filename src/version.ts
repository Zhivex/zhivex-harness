import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
  engines?: {
    bun?: unknown;
  };
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json must contain a non-empty version.");
}

if (typeof packageMetadata.engines?.bun !== "string" || packageMetadata.engines.bun.length === 0) {
  throw new Error("package.json must contain a non-empty engines.bun requirement.");
}

/** The application version. package.json is the single source of truth. */
export const HARNESS_VERSION = packageMetadata.version;

/** The Bun compatibility range declared by the package. */
export const BUN_ENGINE_RANGE = packageMetadata.engines.bun;
