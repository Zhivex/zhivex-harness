import assert from "node:assert/strict";

export const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
export function pairedSummary(before: number[], after: number[]) {
  assert(before.length === after.length && before.length > 0);
  const differences = before.map((value, i) => value - after[i]!);
  const ratios = before.map((value, i) => Math.log(after[i]! / value));
  const rng = random(13112026), boot: number[] = [], bootRatio: number[] = [];
  for (let sample = 0; sample < 10_000; sample++) {
    const indexes = before.map(() => Math.floor(rng() * before.length));
    boot.push(mean(indexes.map(i => differences[i]!)));
    bootRatio.push(Math.exp(mean(indexes.map(i => ratios[i]!))));
  }
  boot.sort((a, b) => a - b); bootRatio.sort((a, b) => a - b);
  return { pairs: before.length, beforeMeanMs: mean(before), afterMeanMs: mean(after), beforeMedianMs: median(before), afterMedianMs: median(after),
    meanReductionMs: mean(differences), medianReductionMs: median(differences), meanReduction95CI: [boot[249]!, boot[9749]!],
    geometricAfterBeforeRatio: Math.exp(mean(ratios)), ratio95CI: [bootRatio[249]!, bootRatio[9749]!],
    fasterPairs: differences.filter(value => value > 0).length };
}

