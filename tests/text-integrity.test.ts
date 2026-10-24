import { expect, test } from "bun:test";
import { firstDisallowedControl, firstDisallowedControlBytes, textGuards } from "../src/workspace/text-integrity.js";

test("control scans name the line and allow tabs, CR, LF, and unicode", () => {
  expect(firstDisallowedControl("a\nb\0c")).toEqual({ line: 2, label: "NUL byte" });
  expect(firstDisallowedControl("keep\n\u0001")).toEqual({ line: 2, label: "U+0001" });
  expect(firstDisallowedControl("tab\there\r\nline\u00e9")).toBeUndefined();
  expect(firstDisallowedControlBytes(Buffer.from("a\nb\n\0c"))).toEqual({ line: 3, label: "NUL byte" });
  expect(textGuards.afterWrite(Buffer.from("a\nb\n\0c"), false)?.line).toBe(3);
  expect(textGuards.afterWrite(Buffer.from("a\nb\n\0c"), true)).toBeUndefined();
  expect(() => textGuards.beforeWrite("ok\n", false)).not.toThrow();
  expect(() => textGuards.beforeWrite("\0", true)).not.toThrow();
});
