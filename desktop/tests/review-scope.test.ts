import { describe, expect, test } from "bun:test";
import { reviewScope, preventDecisionEnter, type ReviewScope } from "../src/review-scope.js";

const review = (items: ReviewScope["items"]): ReviewScope => ({ runId: "run", revision: 1, ticketId: "ticket", items });

describe("review decision scope", () => {
  test("deduplicates paths across requests while counting each command", () => {
    const scope = reviewScope(review([
      { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }], commands: ["bun test"] },
      { files: [{ path: "src/a.ts" }], commands: [] },
    ]));
    expect(scope.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope.approveLabel).toBe("Approve 2 files + 1 command");
  });

  test("handles files-only and commands-only reviews", () => {
    expect(reviewScope(review([{ files: [{ path: "a" }], commands: [] }])).approveLabel).toBe("Approve 1 file");
    const commands = reviewScope(review([{ files: [], commands: ["bun test", "bun test"] }]));
    expect(commands.paths).toEqual([]);
    expect(commands.approveLabel).toBe("Approve 2 commands");
    expect(reviewScope(review([{ files: [], commands: ["bun test"] }])).approveLabel).toBe("Approve 1 command");
  });

  test("does not invent a file count for empty or unavailable reviews", () => {
    expect(reviewScope(undefined).paths).toEqual([]);
    expect(reviewScope(review([])).approveLabel).toBe("Approve requests");
  });

  test("blocks Enter native activation; preserves Space and navigation", () => {
    for (const key of ["Enter", " ", "Tab", "ArrowDown"]) {
      let prevented = false;
      preventDecisionEnter({ key, preventDefault() { prevented = true; } });
      expect(prevented).toBe(key === "Enter");
    }
  });
});
