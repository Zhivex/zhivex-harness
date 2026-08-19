import { describe, expect, test } from "bun:test";

import {
  RegistryPropagationDeadlineError,
  RegistryPropagationError,
  runWithPropagationDeadline,
  timeoutWithinDeadline
} from "../scripts/release-verification-deadline.js";

describe("release verification propagation deadline", () => {
  test("caps every request timeout by the remaining deadline", () => {
    expect(timeoutWithinDeadline(300_000, 30_000, 250_000)).toBe(30_000);
    expect(timeoutWithinDeadline(300_000, 30_000, 295_500)).toBe(4_500);
    expect(() => timeoutWithinDeadline(300_000, 30_000, 300_000)).toThrow(
      "registry propagation deadline expired"
    );
  });

  test("bounds slow request retries and sleeps by one absolute five-minute window", async () => {
    const deadlineMs = 300_000;
    const requestTimeouts: number[] = [];
    const sleeps: number[] = [];
    let clockMs = 0;

    const result = runWithPropagationDeadline(
      async (deadline) => {
        const requestTimeout = timeoutWithinDeadline(deadline, 30_000, clockMs);
        requestTimeouts.push(requestTimeout);
        clockMs += requestTimeout;
        throw new RegistryPropagationError("simulated request timeout");
      },
      {
        deadlineMs,
        retryDelayMs: 10_000,
        now: () => clockMs,
        sleep: async (durationMs) => {
          sleeps.push(durationMs);
          clockMs += durationMs;
        }
      }
    );

    await expect(result).rejects.toBeInstanceOf(RegistryPropagationDeadlineError);
    expect(clockMs).toBe(deadlineMs);
    expect(requestTimeouts.at(-1)).toBe(20_000);
    expect(requestTimeouts.every((durationMs) => durationMs <= 30_000)).toBeTrue();
    expect(sleeps.every((durationMs) => durationMs <= 10_000)).toBeTrue();
  });

  test("caps the final sleep by the time left before the deadline", async () => {
    const sleeps: number[] = [];
    let clockMs = 0;

    const result = runWithPropagationDeadline(
      async () => {
        clockMs = 299_995;
        throw new RegistryPropagationError("still propagating");
      },
      {
        deadlineMs: 300_000,
        retryDelayMs: 10_000,
        now: () => clockMs,
        sleep: async (durationMs) => {
          sleeps.push(durationMs);
          clockMs += durationMs;
        }
      }
    );

    await expect(result).rejects.toBeInstanceOf(RegistryPropagationDeadlineError);
    expect(sleeps).toEqual([5]);
    expect(clockMs).toBe(300_000);
  });

  test("does not retry permanent verification failures", async () => {
    let attempts = 0;

    await expect(runWithPropagationDeadline(
      async () => {
        attempts += 1;
        throw new Error("integrity mismatch");
      },
      {
        deadlineMs: 300_000,
        retryDelayMs: 10_000,
        now: () => 0,
        sleep: async () => {}
      }
    )).rejects.toThrow("integrity mismatch");
    expect(attempts).toBe(1);
  });
});
