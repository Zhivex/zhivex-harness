export class RegistryPropagationError extends Error {}

export class RegistryPropagationDeadlineError extends Error {
  constructor(readonly lastError: unknown) {
    super("registry propagation did not settle before the absolute deadline");
    this.name = "RegistryPropagationDeadlineError";
  }
}

interface PropagationDeadlineOptions {
  deadlineMs: number;
  retryDelayMs: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

export const timeoutWithinDeadline = (
  deadlineMs: number,
  maximumTimeoutMs: number,
  nowMs = performance.now()
): number => {
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    throw new RegistryPropagationError("registry propagation deadline expired");
  }
  return Math.max(0, Math.min(maximumTimeoutMs, Math.floor(remainingMs)));
};

export const runWithPropagationDeadline = async (
  verify: (deadlineMs: number) => Promise<void>,
  {
    deadlineMs,
    retryDelayMs,
    now = () => performance.now(),
    sleep = (durationMs) => Bun.sleep(durationMs)
  }: PropagationDeadlineOptions
): Promise<void> => {
  let lastError: unknown;

  while (now() < deadlineMs) {
    try {
      await verify(deadlineMs);
      return;
    } catch (error) {
      if (!(error instanceof RegistryPropagationError)) throw error;
      lastError = error;
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(retryDelayMs, remainingMs));
  }

  throw new RegistryPropagationDeadlineError(lastError);
};
