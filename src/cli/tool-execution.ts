/** Unknown names return an error receipt; they never acquire execution authority. */
export const cliToolExecution = {
  parallel: true,
  independentOnly: true,
  maxConcurrency: 4,
  stopOnError: false,
  unknownToolMode: "tool-result"
} as const;
