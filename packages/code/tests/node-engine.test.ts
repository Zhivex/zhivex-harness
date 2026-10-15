import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeEngineError } from "../src/cli/node-engine.js";

test("startup rejects Node below 22.13 and accepts the supported range", () => {
  const range = ">=22.13.0";
  expect(nodeEngineError("22.12.9", range)).toContain("does not satisfy the package engine requirement");
  expect(nodeEngineError("22.13.0", range)).toBeUndefined();
  expect(nodeEngineError("22.18.0", range)).toBeUndefined();
});

test("supported Node still prints the Code version before the engine loads", () => {
  if (!process.versions.bun) return;
  const result = spawnSync(process.execPath, ["src/cli-entry.ts", "--version"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
  expect(result.stderr).toBe("");
});
