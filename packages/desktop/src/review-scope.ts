export type ReviewRestriction = "REDACTED" | "TOO_LARGE" | "INVALID_PAYLOAD" | "BASE_UNAVAILABLE";

export type ReviewScope = {
  runId: string;
  revision: number;
  ticketId: string;
  items: readonly {
    files: readonly { path: string }[];
    commands: readonly string[];
    name?: string;
    restriction?: ReviewRestriction;
  }[];
};

export const reviewConsequence = "The decision covers all displayed requests. Rejecting blocks these operations; the agent may continue with another proposal.";

function counted(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function filesViewedLabel(count: number, total: number) {
  return `${count} of ${counted(total, "file")} viewed`;
}

/** Items with neither a reviewed file nor a reviewed command still approve when the batch does. */
function isOtherOperation(item: ReviewScope["items"][number]) {
  return item.files.length === 0 && item.commands.length === 0;
}

export function reviewScope(review: ReviewScope | undefined) {
  const paths = [...new Set(review?.items.flatMap(item => item.files.map(file => file.path)) ?? [])];
  const commands = review?.items.reduce((total, item) => total + item.commands.length, 0) ?? 0;
  const others = review?.items.filter(isOtherOperation).length ?? 0;
  const parts = [
    paths.length ? counted(paths.length, "file") : "",
    commands ? counted(commands, "command") : "",
    others ? counted(others, "other operation") : "",
  ].filter(Boolean);
  return { paths, commands, others, approveLabel: `Approve ${parts.join(" + ") || "requests"}` };
}

/** Command-only reviews name the commands and omit a zero file count. */
export function reviewScopeSummary(operations: number, files: number, commands: number) {
  const parts = [`${operations} operation${operations === 1 ? "" : "s"}`];
  if (files > 0 || commands === 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Enter must not trigger the native button click that would decide a review. */
export function preventDecisionEnter(event: { key: string; preventDefault(): void }) {
  if (event.key === "Enter") event.preventDefault();
}
