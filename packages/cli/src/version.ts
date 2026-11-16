import { createRequire } from "node:module";
const metadata = createRequire(import.meta.url)("../package.json") as {version: string; engines: {node: string}};
// Product identity is separate from the Harness engine dependency version.
export const CODE_VERSION = metadata.version;
export const NODE_ENGINE_RANGE = metadata.engines.node;
export const BUN_ENGINE_RANGE = ">=1.4.0";
