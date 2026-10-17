import { expect, test } from "bun:test";
import { compactToolResult } from "../src/cli/terminal/tool-activity.js";

test("a rejected operation says rejected by you and does not echo the tool", () => {
  const denied = compactToolResult({ toolName: "SECRET_TOOL", isError: true,
    error: { message: "Tool \"SECRET_TOOL\" was denied by the approval policy." } });
  expect(denied).toContain("rejected by you");
  expect(denied).not.toContain("operation failed");
  expect(denied).not.toContain("SECRET");
  const binary = compactToolResult({ toolName: "read_file", isError: true,
    error: { message: "The file appears to be binary and cannot be read as text: NUL byte at L2283." } });
  expect(binary).toBe("✗ Reading a file · file is binary: NUL byte at L2283. Restore the text version, then read it again.");
  const reverted = compactToolResult({ toolName: "apply_reviewed_replacement", isError: true,
    error: { message: "file is binary after edit: NUL byte at L2283. The edit was reverted. Read the file again before retrying." } });
  expect(reverted).toContain("file is binary after edit: NUL byte at L2283");
  expect(reverted).toContain("Read the file again before retrying.");
  const hidden = compactToolResult({ toolName: "read_file", isError: true, error: { message: "SECRET=abc blew up" } });
  expect(hidden).toContain("Inspect /activity and retry that file.");
  expect(hidden).not.toContain("SECRET");
});
