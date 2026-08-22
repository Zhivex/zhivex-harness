import { describe, expect, test } from "bun:test";

import { parseReleaseStatus } from "../scripts/release-status.js";

const status = {
  schemaVersion: 1,
  package: "@zhivex-ai/harness",
  version: "0.11.0",
  status: "published",
  channel: "latest",
  tag: "v0.11.0",
  sourceCommit: "a".repeat(40),
  registry: "https://registry.npmjs.org/",
  registryIntegrity: `sha512-${"A".repeat(86)}==`,
  provenance: "verified",
  githubRelease: "https://github.com/Zhivex/zhivex-harness/releases/tag/v0.11.0",
  publishedAt: "2026-08-22T01:14:33.751Z",
  liveCertification: {
    status: "partial",
    base: "passed-local-tag-source",
    orchestration: "passed-local-tag-source",
    routing: "passed-local-tag-source",
    execution: "pending-release-bound-run",
    remoteWorkflow: "blocked-missing-environment-secrets",
    remoteWorkflowRun: "https://github.com/Zhivex/zhivex-harness/actions/runs/32541832285",
    observedAt: "2026-08-22T10:27:47.792Z"
  }
} as const;

describe("release status", () => {
  test("accepts a strict published release record", () => {
    expect(parseReleaseStatus(status)).toEqual(status);
  });

  test("rejects tag/version drift and unverified published provenance", () => {
    expect(() => parseReleaseStatus({
      ...status,
      tag: "v0.10.0",
      provenance: "pending"
    })).toThrow();
  });

  test("rejects unknown evidence fields", () => {
    expect(() => parseReleaseStatus({
      ...status,
      liveCertification: {
        ...status.liveCertification,
        rawProviderOutput: "forbidden"
      }
    })).toThrow();
  });
});
