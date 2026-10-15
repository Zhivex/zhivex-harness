import { expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/arguments.js";

test("code accepts the experimental audit commands", () => {
  expect(parseCliArgs(["export-audit", "task-1", "--out", "pack", "--workspace", "."])).toMatchObject({
    command: "export-audit", runId: "task-1", auditOut: "pack", workspace: "."
  });
  expect(parseCliArgs(["verify-audit", "--out", "pack", "--json"])).toMatchObject({ command: "verify-audit", auditOut: "pack", json: true });
  expect(() => parseCliArgs(["export-audit", "task-1"])).toThrow("requires --out");
  expect(() => parseCliArgs(["runs", "inspect", "run-1", "--out", "pack"])).toThrow("supported only by export-audit");
});
