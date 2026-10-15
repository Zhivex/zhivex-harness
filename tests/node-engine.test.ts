import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { nodeEngineError } from "../src/cli/node-engine.js";

test("startup rejects Node below 22.13 and accepts the supported range", () => {
  const range = ">=22.13.0";
  expect(nodeEngineError("22.12.9", range)).toContain("does not satisfy the package engine requirement");
  expect(nodeEngineError("20.19.0", range)).toContain("20.19.0");
  expect(nodeEngineError("22.13.0", range)).toBeUndefined();
  expect(nodeEngineError("24.21.0", range)).toBeUndefined();
  expect(nodeEngineError("not-a-version", range)).toContain("not-a-version");
});

test("supported Node still prints the version before the engine loads", () => {
  if (!process.versions.bun) return;
  const result = spawnSync(process.execPath, ["src/cli-entry.ts", "--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("1.4.1");
  expect(result.stderr).toBe("");
});
