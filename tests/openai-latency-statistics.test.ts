import { expect, test } from "bun:test";
import { pairedSummary } from "../scripts/benchmarks/paired-statistics.js";

test("paired bootstrap retains shared latency variation and reports no effect for identical pairs", () => {
  const values = [100, 1000, 200, 5000];
  expect(pairedSummary(values, values).meanReduction95CI).toEqual([0, 0]);
  expect(pairedSummary(values, values).ratio95CI).toEqual([1, 1]);
  expect(pairedSummary(values, values.map(value => value - 10)).meanReduction95CI).toEqual([10, 10]);
});

test("paired effect direction and deterministic intervals distinguish regressions", () => {
  const before = [100, 200, 300, 400], after = before.map(value => value * 1.25);
  const result = pairedSummary(before, after);
  expect(result.meanReduction95CI[1]).toBeLessThan(0);
  expect(result.geometricAfterBeforeRatio).toBeCloseTo(1.25);
  expect(result.fasterPairs).toBe(0);
  expect(pairedSummary(before, after)).toEqual(result);
});
