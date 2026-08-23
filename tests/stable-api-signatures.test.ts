import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertStableApiSignatureSnapshot,
  buildStableApiSignatureSnapshot,
  parseStableApiSignatureSnapshot,
  type PublicApiStabilityContract
} from "../scripts/stable-api-signatures.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async (modelProperty = "value: string") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-signature-test-"));
  directories.push(directory);
  await writeFile(path.join(directory, "model.d.ts"), [
    `export interface BetaModel { ${modelProperty}; }`,
    "export interface StableModel { model: BetaModel; }"
  ].join("\n"), "utf8");
  await writeFile(path.join(directory, "index.d.ts"), [
    'export { makeStable } from "./runtime.js";',
    'export type { BetaModel, StableModel } from "./model.js";'
  ].join("\n"), "utf8");
  await writeFile(path.join(directory, "runtime.d.ts"), [
    'import type { StableModel } from "./model.js";',
    "export declare const makeStable: (input: StableModel) => StableModel;"
  ].join("\n"), "utf8");
  const contract: PublicApiStabilityContract = {
    targetVersion: "1.0.0",
    stableSignatures: "stable-api-signatures.json",
    runtimeExports: ["makeStable"],
    stableRuntimeExports: ["makeStable"],
    betaRuntimeExports: [],
    experimentalRuntimeExports: [],
    typeExports: ["BetaModel", "StableModel"],
    stableTypeExports: ["StableModel"],
    betaTypeExports: ["BetaModel"],
    experimentalTypeExports: []
  };
  return { directory, contract };
};

describe("Stable API declaration signatures", () => {
  test("is deterministic and validates its aggregate digest", async () => {
    const { directory, contract } = await fixture();
    const first = buildStableApiSignatureSnapshot(path.join(directory, "index.d.ts"), contract);
    const second = buildStableApiSignatureSnapshot(path.join(directory, "index.d.ts"), contract);
    expect(second).toEqual(first);
    expect(parseStableApiSignatureSnapshot(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  test("binds the declaration closure exposed through a Stable signature", async () => {
    const beforeFixture = await fixture();
    const before = buildStableApiSignatureSnapshot(
      path.join(beforeFixture.directory, "index.d.ts"),
      beforeFixture.contract
    );
    const afterFixture = await fixture("value: string; added: number");
    const after = buildStableApiSignatureSnapshot(
      path.join(afterFixture.directory, "index.d.ts"),
      afterFixture.contract
    );
    expect(after.stableRuntimeExports[0]!.sha256).not.toBe(before.stableRuntimeExports[0]!.sha256);
    expect(after.stableTypeExports[0]!.sha256).not.toBe(before.stableTypeExports[0]!.sha256);
    expect(() => assertStableApiSignatureSnapshot(before, after)).toThrow("signatures drifted");
  });

  test("rejects a tampered snapshot digest", async () => {
    const { directory, contract } = await fixture();
    const snapshot = buildStableApiSignatureSnapshot(path.join(directory, "index.d.ts"), contract);
    expect(() => parseStableApiSignatureSnapshot({ ...snapshot, digest: `sha256:${"0".repeat(64)}` }))
      .toThrow("digest is invalid");
  });
});
