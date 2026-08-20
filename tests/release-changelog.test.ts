import { describe, expect, test } from "bun:test";

import { findReleaseChangelogHeading } from "../scripts/release-changelog.js";

describe("release changelog headings", () => {
  test("accepts candidate and dated headings for the exact version", () => {
    expect(findReleaseChangelogHeading("## 0.8.0 - Unreleased\n", "0.8.0")).toEqual({
      kind: "unreleased",
      value: "Unreleased"
    });
    expect(findReleaseChangelogHeading("## 0.8.0 - 2026-08-20\n", "0.8.0")).toEqual({
      kind: "dated",
      value: "2026-08-20"
    });
  });

  test("rejects another version and malformed release suffixes", () => {
    expect(findReleaseChangelogHeading("## 0.7.0 - 2026-08-20\n", "0.8.0")).toBeUndefined();
    expect(findReleaseChangelogHeading("## 0.8.0 - tomorrow\n", "0.8.0")).toBeUndefined();
  });
});
