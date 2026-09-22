import { expect, test } from "bun:test";
import path from "node:path";
import { architectureViolations, checkArchitecture, sourceDependencies } from "../scripts/check-architecture.js";

test("source boundaries hold across runtime and Desktop", async () => {
  expect(await checkArchitecture(path.resolve(import.meta.dir, ".."))).toEqual([]);
});

test("Desktop cannot bypass the surface with direct, dynamic, or re-exported imports", () => {
  for (const source of [
    'import { createHarness } from "../../src/runtime/harness.js";',
    'export { createHarness } from "../../src/runtime/harness.js";',
    'const runtime = import("../../src/runtime/harness.js");',
    'const runtime = require("../../src/runtime/harness.js");',
    'type Runtime = import("../../src/runtime/harness.js").ZhivexHarness;',
  ]) expect(architectureViolations("desktop/src/runtime.ts", source)).toHaveLength(1);
  expect(architectureViolations("desktop/src/runtime.ts", 'import { createHarness } from "../../src/internal/desktop/runtime.js";')).toEqual([]);
});

test("protocol boundaries distinguish erased type references from runtime loading", () => {
  expect(architectureViolations("src/client/protocol.ts", 'import type { CliSession } from "../persistence/sessions.js"; import { z } from "zod";')).toEqual([]);
  expect(architectureViolations("src/client/protocol.ts", 'import { type CliSession } from "../persistence/sessions.js";')).toEqual([]);
  for (const source of ['import "../persistence/sessions.js";', 'import { openCliSessionStore, type CliSession } from "../persistence/sessions.js";', 'import fs from "node:fs";']) {
    expect(architectureViolations("src/client/protocol.ts", source)).toHaveLength(1);
  }
  expect(architectureViolations("src/internal/desktop/protocol.ts", 'export { createHarness } from "../../runtime/harness.js";')).toHaveLength(1);
});

test("implementation modules cannot depend back on their composition roots", () => {
  expect(architectureViolations("src/cli/console.ts", 'import { main } from "../cli.js";')).toHaveLength(1);
  expect(architectureViolations("src/tools/workspace.ts", 'import { createHarness } from "../runtime/harness.js";')).toHaveLength(1);
  expect(architectureViolations("src/runtime/config.ts", 'import { modelSelectionSchema } from "../../desktop/src/model-selection.js";')).toHaveLength(1);
  expect(sourceDependencies('export type { CliSession } from "./sessions.js";')).toEqual([{ target: "./sessions.js", typeOnly: true }]);
});

test("source root is reserved for entrypoints and package metadata", () => {
  expect(architectureViolations("src/new-feature.ts", "export const feature = true;")).toHaveLength(1);
  expect(architectureViolations("src/runtime/new-feature.ts", "export const feature = true;")).toEqual([]);
  for (const name of ["index", "cli", "service-cli", "version"]) {
    expect(architectureViolations(`src/${name}.ts`, "")).toEqual([]);
  }
});

test("Desktop protocol bundles for a browser without host runtime dependencies", async () => {
  const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/internal/desktop/protocol.ts")], target: "browser" });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});
