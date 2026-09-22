import { expect, test } from "bun:test";
import { validateCodeqlPins } from "../scripts/codeql-policy.js";

const workflow = (init: string, analyze = init) => `steps:\n  - uses: github/codeql-action/init@${init}\n  - uses: github/codeql-action/analyze@${analyze}\n`;

test("accepts coordinated SHA updates without a hardcoded version", () => {
  expect(validateCodeqlPins(workflow("a".repeat(40)))).toEqual([]);
  expect(validateCodeqlPins(workflow("b".repeat(40)))).toEqual([]);
});

test("rejects independent updates, mutable tags, missing and duplicate steps", () => {
  expect(validateCodeqlPins(workflow("a".repeat(40), "b".repeat(40)))).not.toEqual([]);
  expect(validateCodeqlPins(workflow("v4"))).not.toEqual([]);
  expect(validateCodeqlPins("# uses: github/codeql-action/init@v4")).not.toEqual([]);
  expect(validateCodeqlPins(workflow("a".repeat(40)).repeat(2))).not.toEqual([]);
});
