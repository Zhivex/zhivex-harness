/** Unknown names return an error receipt; they never acquire execution authority. */
export const cliToolExecution = {
  parallel: false,
  stopOnError: false,
  unknownToolMode: "tool-result"
} as const;
