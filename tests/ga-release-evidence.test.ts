import { describe, expect, test } from "bun:test";

import {
  GA_REPRESENTATIVE_EVALUATION_PROVIDERS,
  GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
  assertDistinctGaReleaseCandidateEvidence,
  parseGaReleaseCandidateEvidence,
  parseGaRepresentativeEvaluationCoverage,
  parseGaSecurityReviewEvidencePath,
  verifyPublishedGaReleaseCandidate,
  type GaReleaseCandidateEvidence,
  type GaReleaseEvidenceDependencies,
  type GaRepresentativeEvaluationResult
} from "../scripts/ga-release-evidence.js";
import type { ProvenanceStatement } from "../scripts/release-provenance.js";

const sha512Hex = "a".repeat(128);
const artifactSha512 = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
const sourceCommit = "b".repeat(40);
const workflowUrl = "https://github.com/Zhivex/zhivex-harness/actions/runs/32195815991";

const evidence = (overrides: Partial<GaReleaseCandidateEvidence> = {}) => ({
  version: "1.0.0-rc.1",
  status: "passed",
  channel: "next",
  tag: "v1.0.0-rc.1",
  contractBreakingDefects: 0,
  publishedAt: "2026-08-23T12:00:00.000Z",
  sourceCommit,
  artifactSha512,
  workflowUrl,
  provenance: "verified",
  liveCertification: "passed-release-bound-run",
  ...overrides
} satisfies GaReleaseCandidateEvidence);

const secondEvidence = () => evidence({
  version: "1.0.0-rc.2",
  tag: "v1.0.0-rc.2",
  sourceCommit: "c".repeat(40),
  artifactSha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  workflowUrl: "https://github.com/Zhivex/zhivex-harness/actions/runs/32195815992"
});

const evaluationResults = (
  candidates: readonly GaReleaseCandidateEvidence[]
): GaRepresentativeEvaluationResult[] => candidates.flatMap((candidate, candidateIndex) =>
  GA_REPRESENTATIVE_EVALUATION_PROVIDERS.map((provider) => ({
    releaseTag: candidate.tag,
    sourceCommit: candidate.sourceCommit,
    artifactSha512: candidate.artifactSha512,
    provider,
    model: `${provider}-fixture`,
    datasetRevision: "representative-v1",
    driverCommit: "d".repeat(40),
    ociImageDigest: `sha256:${"e".repeat(64)}`,
    workflowUrl: `https://github.com/Zhivex/zhivex-harness/actions/runs/${32195816000 + candidateIndex}`,
    observedAt: "2026-08-23T12:30:00.000Z",
    totalRuns: 7,
    failedRuns: 0,
    omittedRuns: 0
  }))
);

const statement = (candidate: GaReleaseCandidateEvidence): ProvenanceStatement => ({
  subject: [{ name: "package.tgz", digest: { sha512: sha512Hex } }],
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: "https://github.com/Zhivex/zhivex-harness",
          path: ".github/workflows/release.yml",
          ref: `refs/tags/${candidate.tag}`
        }
      },
      resolvedDependencies: [{ digest: { gitCommit: candidate.sourceCommit } }]
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: { invocationId: `${candidate.workflowUrl}/attempts/1` }
    }
  }
});

const dependenciesFor = (
  candidate: GaReleaseCandidateEvidence,
  integrity = candidate.artifactSha512
): GaReleaseEvidenceDependencies => ({
  runGit: async (arguments_) => {
    if (arguments_[0] === "cat-file") return { exitCode: 0, stdout: "tag", stderr: "" };
    if (arguments_[0] === "rev-list") {
      return { exitCode: 0, stdout: candidate.sourceCommit, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  fetchJson: async (url) => {
    if (url === "https://registry.npmjs.org/%40zhivex-ai%2Fharness") {
      return {
        time: { [candidate.version]: candidate.publishedAt },
        versions: {
          [candidate.version]: {
            dist: {
              integrity,
              attestations: {
                url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture",
                provenance: { predicateType: "https://slsa.dev/provenance/v1" }
              }
            }
          }
        }
      };
    }
    if (url.includes("/attestations/")) {
      return {
        attestations: [{
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement(candidate))).toString("base64")
            }
          }
        }]
      };
    }
    return {
      html_url: candidate.workflowUrl,
      head_sha: candidate.sourceCommit,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/release.yml"
    };
  }
});

describe("GA release-candidate evidence", () => {
  test("binds a candidate to its annotated tag, registry integrity, provenance, and workflow", async () => {
    const candidate = parseGaReleaseCandidateEvidence(evidence());

    await expect(verifyPublishedGaReleaseCandidate(candidate, dependenciesFor(candidate)))
      .resolves.toBeUndefined();
  });

  test("rejects duplicated release evidence across candidates", () => {
    const first = evidence();
    const second = evidence({ version: "1.0.0-rc.2", tag: "v1.0.0-rc.2" });

    expect(() => assertDistinctGaReleaseCandidateEvidence([first, second]))
      .toThrow("distinct sourceCommit");
  });

  test("rejects lightweight tags and registry integrity drift", async () => {
    const candidate = evidence();
    const lightweight = dependenciesFor(candidate);
    lightweight.runGit = async () => ({ exitCode: 0, stdout: "commit", stderr: "" });

    await expect(verifyPublishedGaReleaseCandidate(candidate, lightweight))
      .rejects.toThrow("must be annotated");
    await expect(verifyPublishedGaReleaseCandidate(
      candidate,
      dependenciesFor(candidate, `sha512-${Buffer.alloc(64, 1).toString("base64")}`)
    )).rejects.toThrow("registry integrity differs");
  });

  test("requires one bound provider result for both release candidates", () => {
    const candidates = [evidence(), secondEvidence()];
    const results = evaluationResults(candidates);

    expect(parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE
    )).toHaveLength(6);
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      results.slice(0, 3),
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE
    )).toThrow("exactly 6 candidate/provider results");

    results[3]!.sourceCommit = candidates[0]!.sourceCommit;
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE
    )).toThrow("sourceCommit differs from its release candidate");
  });

  test("requires security review evidence under the dedicated review directory", () => {
    expect(parseGaSecurityReviewEvidencePath("security-reviews/1.0.0.json"))
      .toBe("security-reviews/1.0.0.json");
    expect(() => parseGaSecurityReviewEvidencePath("")).toThrow("under security-reviews");
    expect(() => parseGaSecurityReviewEvidencePath("docs/GA_READINESS.md"))
      .toThrow("under security-reviews");
  });
});
