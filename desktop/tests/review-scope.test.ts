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
    expect(reviewScope(undefined).others).toBe(0);
    expect(reviewScope(review([])).approveLabel).toBe("Approve requests");
  });

  test("counts a file edit together with move_file", () => {
    const scope = reviewScope(review([
      { name: "apply_patch", files: [{ path: "src/a.ts" }], commands: [] },
      { name: "move_file", files: [], commands: [] },
    ]));
    expect(scope.paths).toEqual(["src/a.ts"]);
    expect(scope.others).toBe(1);
    expect(scope.approveLabel).toBe("Approve 1 file + 1 other operation");
  });

  test("counts quarantine_file, restore_file, and any other tool without files or commands", () => {
    expect(reviewScope(review([
      { name: "quarantine_file", files: [], commands: [] },
    ])).approveLabel).toBe("Approve 1 other operation");
    expect(reviewScope(review([
      { name: "restore_file", files: [], commands: [] },
    ])).approveLabel).toBe("Approve 1 other operation");
    expect(reviewScope(review([
      { name: "web_search", files: [], commands: [] },
    ])).approveLabel).toBe("Approve 1 other operation");
  });

  test("counts unreadable and unparsable payloads as other operations", () => {
    expect(reviewScope(review([
      { name: "apply_patch", files: [], commands: [], restriction: "TOO_LARGE" },
    ])).approveLabel).toBe("Approve 1 other operation");
    expect(reviewScope(review([
      { name: "unknown", files: [], commands: [], restriction: "INVALID_PAYLOAD" },
    ])).approveLabel).toBe("Approve 1 other operation");
  });

  test("pluralizes other operations and keeps them beside files and commands", () => {
    const scope = reviewScope(review([
      { name: "apply_patch", files: [{ path: "src/a.ts" }, { path: "src/b.ts" }], commands: ["bun test"] },
      { name: "move_file", files: [], commands: [] },
      { name: "quarantine_file", files: [], commands: [] },
    ]));
    expect(scope.approveLabel).toBe("Approve 2 files + 1 command + 2 other operations");
  });

  test("dedupes paths and still counts other operations and repeated commands", () => {
    const scope = reviewScope(review([
      { name: "apply_patch", files: [{ path: "src/a.ts" }, { path: "src/a.ts" }], commands: ["bun test", "bun lint"] },
      { name: "apply_reviewed_edits", files: [{ path: "src/a.ts" }], commands: [] },
      { name: "restore_file", files: [], commands: [] },
      { name: "move_file", files: [], commands: [] },
    ]));
    expect(scope.paths).toEqual(["src/a.ts"]);
    expect(scope.commands).toBe(2);
    expect(scope.others).toBe(2);
    expect(scope.approveLabel).toBe("Approve 1 file + 2 commands + 2 other operations");
  });

  test("does not hide a batch that contains only other operations", () => {
    expect(reviewScope(review([
      { name: "move_file", files: [], commands: [] },
      { name: "restore_file", files: [], commands: [], restriction: "INVALID_PAYLOAD" },
    ])).approveLabel).toBe("Approve 2 other operations");
  });

  test("blocks Enter native activation; preserves Space and navigation", () => {
    for (const key of ["Enter", " ", "Tab", "ArrowDown"]) {
      let prevented = false;
      preventDecisionEnter({ key, preventDefault() { prevented = true; } });
      expect(prevented).toBe(key === "Enter");
    }
  });
});
