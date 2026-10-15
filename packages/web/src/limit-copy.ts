export const counted = (count: number, singular: string) => `${count} ${singular}${count === 1 ? "" : "s"}`;

/** Shown when the limits request fails before the dialog has settings. */
export const limitsReadError = "Limits could not be read. Reconnect to look them up again.";

/** Shown when a save is not confirmed. Saving again waits for a fresh read. */
export const limitsSaveError = "The change was not confirmed. Close and reopen to look up the limits before saving again.";
