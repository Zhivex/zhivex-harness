/** Recovery returns error receipts to the model without granting authority.
 * Durable budgets still bound retries; callers can opt into fail-fast handling.
 */
export const harnessToolExecution = {
  parallel: true,
  independentOnly: true,
  maxConcurrency: 4,
  stopOnError: false,
  validationErrorMode: "tool-result",
  unknownToolMode: "tool-result"
} as const;
