/** Guidance does not refresh an authorization or retry a filesystem operation. */
export const checkpointRecovery = (message: string): string | undefined => {
  if (!/^(Stale patch rejected for |Restore conflicts|Restore mode conflict|Restore requires the reviewed proposal identity|Fork outcome uncertain)/.test(message)) return undefined;
  return "RESTORE BLOCKED · original preconditions retained\n" + message + "\n" +
    "Inspect current files with /diff and the operation with /checkpoint list.\n" +
    "For a content conflict, review the checkpoint again before a fresh /checkpoint restore.\n" +
    "A partially applied restore or uncertain fork requires manual recovery. /checkpoint retry retains the original digests.\n";
};
