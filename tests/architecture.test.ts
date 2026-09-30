import { expect, test } from "bun:test";
import path from "node:path";
import { architectureViolations, checkArchitecture, sourceDependencies, engineBoundaryViolations } from "../scripts/check-architecture.js";

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
  expect(architectureViolations("desktop/src/runtime.ts", 'import { createHarness } from "../../src/internal/desktop/runtime.js";')).toHaveLength(1);
  expect(architectureViolations("desktop/src/runtime.ts", 'import { createHarness } from "@zhivex-ai/harness/engine";')).toEqual([]);
  for (const target of ["@zhivex-ai/harness", "@zhivex-ai/harness/dist/engine/index.js", "@zhivex-ai/code"]) {
    expect(architectureViolations("desktop/src/runtime.ts", `import anything from "${target}";`)).toHaveLength(1);
  }
});

test("protocol boundaries distinguish erased type references from runtime loading", () => {
  expect(architectureViolations("src/client/protocol.ts", 'import type { CliSession } from "../persistence/sessions.js"; import { z } from "zod";')).toEqual([]);
  expect(architectureViolations("src/client/protocol.ts", 'import { type CliSession } from "../persistence/sessions.js";')).toEqual([]);
  for (const source of ['import "../persistence/sessions.js";', 'import { openCliSessionStore, type CliSession } from "../persistence/sessions.js";', 'import fs from "node:fs";']) {
    expect(architectureViolations("src/client/protocol.ts", source)).toHaveLength(1);
  }
  expect(architectureViolations("src/internal/desktop/protocol.ts", 'export { createHarness } from "../../runtime/harness.js";')).toHaveLength(1);
});

test("Desktop renderer catalog cannot load authentication or transport dependencies", async () => {
  expect(architectureViolations("src/internal/desktop/catalog.ts", 'export { createVertexModel } from "../../providers/vertex-auth.js";')).toHaveLength(1);
  const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/internal/desktop/catalog.ts")], target: "browser" });
  expect(result.success).toBe(true);
});

test("public model catalog bundles for browsers without provider transport or Node dependencies", async () => {
  const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/engine/models.ts")], target: "browser" });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  expect(output).not.toMatch(/google-auth-library|@grpc\/grpc-js|node:fs|createVertexModel/);
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


test("engine closure rejects transitive runtime, re-export and erased reverse dependencies", () => {
  for (const edge of [
    'import "../cli/console.js";',
    'export { x } from "../../packages/code/src/index.js";',
    'import type { X } from "../../desktop/src/types.js";',
    'type X = import("@zhivex-ai/code").X;',
    'const x = import("../cli/console.js");',
    'const x = require("../cli/console.js");',
    'const x = import(target);',
    'const x = require(target);',
    'import x = require("@zhivex-ai/code");',
  ]) {
    const sources = new Map([
      ["src/engine/index.ts", 'export { x } from "../runtime/bridge.js";'],
      ["src/runtime/bridge.ts", edge],
    ]);
    expect(engineBoundaryViolations(sources, ["src/engine/index.ts"])).toHaveLength(1);
  }
});

test("public protocol bundles for browsers with no host runtime", async () => {
  const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/engine/protocol.ts")], target: "browser" });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  const output = await result.outputs[0]!.text();
  expect(output).not.toContain("node:");
  expect(output).not.toContain("@napi-rs/keyring");
});

test("additive engine contracts enumerate exact named exports and preserve historical tiers", async () => {
  const ts = await import("typescript-compiler-api");
  const contract = await Bun.file(path.resolve(import.meta.dir, "../contracts/engine-api.json")).json();
  const historical = await Bun.file(path.resolve(import.meta.dir, "../contracts/public-api.json")).json();
  const manifest = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json();
  for (const [subpath, value] of Object.entries(contract.entrypoints) as [string, { source: string; exports: { name: string; kind: string; tier: string }[] }][]) {
    expect(manifest.exports[subpath]).toEqual({
      types: "./" + value.source.replace(/^src\//, "dist/").replace(/\.ts$/, ".d.ts"),
      import: "./" + value.source.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"),
    });
    const source = await Bun.file(path.resolve(import.meta.dir, "..", value.source)).text();
    const ast = ts.createSourceFile(value.source, source, ts.ScriptTarget.Latest, true);
    const actual: {name:string;kind:string}[] = [];
    for (const statement of ast.statements) {
      if (!ts.isExportDeclaration(statement)) {
        if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const declaration of statement.declarationList.declarations) {
            expect(ts.isIdentifier(declaration.name)).toBe(true);
            if (ts.isIdentifier(declaration.name)) actual.push({ name: declaration.name.text, kind: "runtime" });
          }
        }
        continue;
      }
      expect(statement.exportClause && ts.isNamedExports(statement.exportClause)).toBe(true);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) actual.push({name:element.name.text,kind:statement.isTypeOnly ? "type" : "runtime"});
    }
    expect(actual).toEqual(value.exports.map(({name,kind}) => ({name,kind})));
    for (const item of value.exports) for (const tier of ["stable", "beta", "experimental"]) {
      if (historical[tier + (item.kind === "type" ? "TypeExports" : "RuntimeExports")].includes(item.name)) expect(item.tier).toBe(tier);
    }
  }
});


test("engine closure cannot bypass isolation through self-package aliases or terminal builtins", () => {
  for (const target of ["@zhivex-ai/harness", "@zhivex-ai/harness/engine", "@zhivex-ai/harness/code-support", "node:readline", "readline", "node:readline/promises", "readline/promises", "node:tty", "tty"]) {
    for (const edge of [`export { X } from "${target}";`, `import type { X } from "${target}";`, `const x = import("${target}");`]) {
      const sources = new Map([
        ["src/engine/index.ts", 'export { x } from "../runtime/bridge.js";'],
        ["src/runtime/bridge.ts", edge],
      ]);
      const violations = engineBoundaryViolations(sources, ["src/engine/index.ts"]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`src/engine/index.ts -> src/runtime/bridge.ts -> ${target}`);
    }
  }
});
