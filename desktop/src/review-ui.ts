import { useState } from "react";

import { filesViewedLabel, reviewScope, type ReviewScope } from "./review-scope.js";
export { reviewConsequence, preventDecisionEnter } from "./review-scope.js";

/** Local acknowledgement only; a new run, revision, or ticket always starts unviewed. */
export function useViewedFiles(review: ReviewScope | undefined, runId?: string, revision?: number) {
  const identity = JSON.stringify([runId, revision, review?.runId, review?.revision, review?.ticketId]);
  const [state, setState] = useState<{ identity: string; paths: string[] }>({ identity, paths: [] });
  if (state.identity !== identity) setState({ identity, paths: [] });
  const viewed = state.identity === identity ? state.paths : [];
  const scope = reviewScope(review);
  const count = scope.paths.filter(path => viewed.includes(path)).length;
  return {
    ...scope,
    count,
    viewedLabel: filesViewedLabel(count, scope.paths.length),
    allViewed: count === scope.paths.length,
    isViewed: (path: string) => viewed.includes(path),
    setViewed(path: string, checked: boolean) {
      setState(previous => {
        const paths = previous.identity === identity ? previous.paths.filter(value => value !== path) : [];
        return { identity, paths: checked ? [...paths, path] : paths };
      });
    },
  };
}
