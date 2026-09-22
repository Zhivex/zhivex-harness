import { expect, test } from "bun:test";
import { auditDependencies } from "../scripts/audit-dependencies.js";

test("retries registry outages and returns the eventual result", async () => {
  let calls = 0;
  const delays: number[] = [];
  expect(await auditDependencies(() => {
    calls++;
    return { status: calls === 3 ? 0 : 1, stdout: "", stderr: "error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503" };
  }, async (ms) => { delays.push(ms); }, () => {})).toBe(0);
  expect(calls).toBe(3);
  expect(delays).toEqual([5000, 10000]);
});

test("fails closed after persistent outages or immediately on vulnerabilities and other errors", async () => {
  for (const [stderr, expectedCalls] of [
    ["error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 502", 3],
    ["1 high vulnerability", 1],
    ["error: unauthorized", 1]
  ] as const) {
    let calls = 0;
    expect(await auditDependencies(() => {
      calls++;
      return { status: 1, stdout: "", stderr };
    }, async () => {}, () => {})).toBe(1);
    expect(calls).toBe(expectedCalls);
  }
});
