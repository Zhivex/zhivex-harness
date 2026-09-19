import { expect, test } from "bun:test";
import { boundedBatches } from "../src/bounded-reads.js";

test("bounds concurrency, preserves input order, and starts no work after early termination", async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const output: number[] = [];
  for await (const batch of boundedBatches([0, 1, 2, 3, 4, 5], async (value) => {
    started++; active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (3 - value) * 2));
    active--;
    return value;
  }, 3)) { output.push(...batch); break; }
  expect(output).toEqual([0, 1, 2]);
  expect(peak).toBe(3);
  expect(active).toBe(0);
  expect(started).toBe(3);
});

test("drains sibling operations before propagating a failed batch", async () => {
  let siblingFinished = false;
  let started = 0;
  const run = async () => {
    for await (const _batch of boundedBatches([0, 1, 2], async (value) => {
      started++;
      if (value === 0) throw new Error("read failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      siblingFinished = true;
    }, 2)) { /* consume */ }
  };
  await expect(run()).rejects.toThrow("read failed");
  expect(siblingFinished).toBe(true);
  expect(started).toBe(2);
});
