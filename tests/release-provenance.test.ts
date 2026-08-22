import { describe, expect, test } from "bun:test";

import {
  assertReleaseProvenance,
  type ProvenanceStatement
} from "../scripts/release-provenance.js";

const version = "0.11.0";
const sha512Hex = "a".repeat(128);
const releaseCommit = "b".repeat(40);

const statementFor = (ref: string): ProvenanceStatement => ({
  subject: [{ name: "package.tgz", digest: { sha512: sha512Hex } }],
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: "https://github.com/Zhivex/zhivex-harness",
          path: ".github/workflows/release.yml",
          ref
        }
      },
      resolvedDependencies: [{ digest: { gitCommit: releaseCommit } }]
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: {
        invocationId: "https://github.com/Zhivex/zhivex-harness/actions/runs/32195815991/attempts/1"
      }
    }
  }
});

const verify = (ref: string) => assertReleaseProvenance({
  statement: statementFor(ref),
  version,
  sha512Hex,
  releaseCommit
});

describe("release provenance", () => {
  test("accepts a canonical workflow dispatch from main", () => {
    expect(verify("refs/heads/main")).toBe("refs/heads/main");
  });

  test("accepts a workflow dispatch from the exact version tag", () => {
    expect(verify("refs/tags/v0.11.0")).toBe("refs/tags/v0.11.0");
  });

  test.each([
    "refs/tags/v0.6.0",
    "refs/tags/v0.7.0",
    "refs/tags/v0.10.0",
    "refs/heads/feat/release-provenance-verifier"
  ])("rejects an unrelated workflow ref: %s", (ref) => {
    expect(() => verify(ref)).toThrow(
      "provenance workflow ref must be refs/heads/main or refs/tags/v0.11.0"
    );
  });

  test("still rejects provenance bound to another source commit", () => {
    const statement = statementFor("refs/tags/v0.11.0");
    statement.predicate!.buildDefinition!.resolvedDependencies = [
      { digest: { gitCommit: "c".repeat(40) } }
    ];

    expect(() => assertReleaseProvenance({ statement, version, sha512Hex, releaseCommit })).toThrow(
      "provenance source commit differs from the annotated release tag"
    );
  });
});
