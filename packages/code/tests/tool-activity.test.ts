import { expect, test } from "bun:test";
import { compactToolResult } from "../src/cli/terminal/tool-activity.js";

test("a rejected operation says rejected by you and does not echo the tool", () => {
  const denied = compactToolResult({ toolName: "SECRET_TOOL", isError: true,
    error: { message: "Tool \"SECRET_TOOL\" was denied by the approval policy." } });
  expect(denied).toContain("rejected by you");
  expect(denied).not.toContain("operation failed");
  expect(denied).not.toContain("SECRET");
});
