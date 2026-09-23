import { describe, expect, test } from "bun:test";
import { checkOnboardingDocument, checkStableRoadmap } from "../scripts/onboarding-docs.js";

describe("stable onboarding documentation", () => {
  test("rejects old, prerelease and floating installation pins with locations", () => {
    for (const pin of ["0.11.1", "1.0.0-rc.13", "next", "latest"]) {
      const errors = checkOnboardingDocument("README.md", `Install:\nbunx @zhivex-ai/harness@${pin} --version`, "1.0.0");
      expect(errors).toEqual([`README.md:2: installation pin ${pin} must be 1.0.0`]);
    }
    expect(checkOnboardingDocument("examples/README.md", "bun add --exact @zhivex-ai/harness@0.11.1", "1.0.0")).toHaveLength(1);
  });
  test("permits stable pins and historical references without installation commands", () => {
    expect(checkOnboardingDocument("README.md", "bunx @zhivex-ai/harness@1.0.0 --help\nHistorical RC.13: [changelog](CHANGELOG.md).", "1.0.0")).toEqual([]);
  });
  test("rejects stale onboarding status and a planned stable roadmap", () => {
    expect(checkOnboardingDocument("docs/CLI.md", "The `1.0` candidate is Node-first.", "1.0.0")).toHaveLength(1);
    expect(checkOnboardingDocument("README.md", "## What RC.13 adds", "1.0.0")).toHaveLength(1);
    expect(checkStableRoadmap("| `1.0.0` | Stable contract | Planned |", "1.0.0")).toHaveLength(1);
    expect(checkStableRoadmap("| `1.0.0` | Stable contract | Published on npm as `latest` |", "1.0.0")).toEqual([]);
  });
});


test("pending stable preparation cannot claim publication", () => {
  const pending = "| `1.1.0` | Compatible minor | Pending stable publication |";
  const published = "| `1.1.0` | Compatible minor | Published on npm as `latest` |";
  expect(checkStableRoadmap(pending, "1.1.0", "pending")).toEqual([]);
  expect(checkStableRoadmap(published, "1.1.0", "pending")).toHaveLength(1);
  expect(checkStableRoadmap(pending, "1.1.0", "published")).toHaveLength(1);
  expect(checkStableRoadmap(published, "1.1.0", "published")).toEqual([]);
  expect(checkStableRoadmap(pending + " Published on npm as `latest`", "1.1.0", "pending")).toHaveLength(1);
});
