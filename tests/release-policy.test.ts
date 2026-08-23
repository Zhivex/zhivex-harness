import { describe, expect, test } from "bun:test";

import {
  assertHarnessReleaseChannel,
  parseHarnessReleaseVersion
} from "../scripts/release-policy.js";

describe("release version and channel policy", () => {
  test("routes stable releases to latest and release candidates to next", () => {
    expect(parseHarnessReleaseVersion("0.11.1")).toMatchObject({
      tag: "v0.11.1",
      prerelease: false,
      channel: "latest"
    });
    expect(parseHarnessReleaseVersion("1.0.0-rc.1")).toMatchObject({
      tag: "v1.0.0-rc.1",
      prerelease: true,
      releaseCandidate: 1,
      channel: "next"
    });
    expect(parseHarnessReleaseVersion("1.0.0")).toMatchObject({
      prerelease: false,
      channel: "latest"
    });
  });

  test("fails closed on invalid versions and mismatched channels", () => {
    for (const invalid of [
      "0.10.9",
      "1.0.0-alpha.1",
      "1.0.0-rc.0",
      "1.0.0-rc.01",
      "01.0.0",
      "1.0",
      "v1.0.0"
    ]) {
      expect(() => parseHarnessReleaseVersion(invalid), invalid).toThrow();
    }
    expect(() => assertHarnessReleaseChannel("1.0.0-rc.1", "latest")).toThrow("must use npm channel next");
    expect(() => assertHarnessReleaseChannel("1.0.0", "next")).toThrow("must use npm channel latest");
    expect(assertHarnessReleaseChannel("1.0.0-rc.2", "next").releaseCandidate).toBe(2);
  });
});
