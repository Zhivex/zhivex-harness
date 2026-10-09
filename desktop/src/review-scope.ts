export type ReviewScope = {
  runId: string;
  revision: number;
  ticketId: string;
  items: readonly {
    files: readonly { path: string }[];
    commands: readonly string[];
  }[];
};

export const reviewConsequence = "The decision covers all displayed requests. Rejecting blocks these operations; the agent may continue with another proposal.";

export function reviewScope(review: ReviewScope | undefined) {
  const paths = [...new Set(review?.items.flatMap(item => item.files.map(file => file.path)) ?? [])];
  const commands = review?.items.reduce((total, item) => total + item.commands.length, 0) ?? 0;
  const parts = [
    paths.length ? `${paths.length} file${paths.length === 1 ? "" : "s"}` : "",
    commands ? `${commands} command${commands === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return { paths, commands, approveLabel: `Approve ${parts.join(" + ") || "requests"}` };
}

/** Enter must not trigger the native button click that would decide a review. */
export function preventDecisionEnter(event: { key: string; preventDefault(): void }) {
  if (event.key === "Enter") event.preventDefault();
}
