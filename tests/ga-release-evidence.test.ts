import { describe, expect, test } from "bun:test";

import {
  GA_REPRESENTATIVE_EVALUATION_PROVIDERS,
  GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
  GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
  assertDistinctGaReleaseCandidateEvidence,
  assertGaReleaseCandidateSequence,
  assertAtLeastTwoPassingGaReleaseCandidates,
  parseGaFailedReleaseCandidateEvidence,
  parseGaReleaseCandidateEvidence,
  parseGaReleaseCandidateRecord,
  parseGaRepresentativeEvaluationCoverage,
  parseGaSecurityReviewEvidencePath,
  verifyGaRepresentativeEvaluationWorkflows,
  verifyPublishedGaReleaseCandidate,
  type GaReleaseCandidateEvidence,
  type GaFailedReleaseCandidateEvidence,
  type GaReleaseEvidenceDependencies,
  type GaRepresentativeEvaluationResult
} from "../scripts/ga-release-evidence.js";
import type { ProvenanceStatement } from "../scripts/release-provenance.js";

const sha512Hex = "a".repeat(128);
const artifactSha512 = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
const sourceCommit = "b".repeat(40);
const workflowUrl = "https://github.com/Zhivex/zhivex-harness/actions/runs/32195815991";
const expectedCases = GA_REPRESENTATIVE_EVALUATION_SCENARIOS.map((scenarioId, index) => ({
  caseId: `case-${index + 1}`,
  scenarioId
}));

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

const failedEvidence = (overrides: Partial<GaFailedReleaseCandidateEvidence> = {}) => ({
  version: "1.0.0-rc.1",
  status: "failed-gates",
  channel: "next",
  tag: "v1.0.0-rc.1",
  contractBreakingDefects: null,
  publishedAt: null,
  sourceCommit,
  artifactSha512,
  workflowUrl,
  provenance: "not-published",
  liveCertification: "failed-release-bound-run",
  observedAt: "2026-08-23T23:54:37Z",
  failedGates: ["live-provider-certification", "representative-evaluation"],
  ...overrides
} satisfies GaFailedReleaseCandidateEvidence);

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
    workflowRunUrl: candidate.workflowUrl,
    observedAt: "2026-08-23T12:30:00.000Z",
    cases: expectedCases.map((entry, index) => ({
      ...entry,
      runId: `${provider}-run-${candidateIndex + 1}-${index + 1}`,
      status: "passed" as const,
      startedAt: `2026-08-23T12:00:${String(index).padStart(2, "0")}.000Z`,
      completedAt: `2026-08-23T12:00:${String(index).padStart(2, "0")}.250Z`,
      durationMs: 250
    })),
    totalRuns: expectedCases.length,
    passedRuns: expectedCases.length,
    failedRuns: 0,
    omittedRuns: 0
  }))
);

const expectedModels = (candidates: readonly GaReleaseCandidateEvidence[]) => candidates.map((candidate) => ({
  releaseTag: candidate.tag,
  models: { meta: "meta-fixture", qwen: "qwen-fixture", openai: "openai-fixture" }
}));

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

  test("requires a contiguous RC sequence while allowing later corrective candidates", () => {
    expect(() => assertGaReleaseCandidateSequence(["1.0.0-rc.1", "1.0.0-rc.2"]))
      .not.toThrow();
    expect(() => assertGaReleaseCandidateSequence([
      "1.0.0-rc.1",
      "1.0.0-rc.2",
      "1.0.0-rc.3"
    ])).not.toThrow();
    expect(() => assertGaReleaseCandidateSequence(["1.0.0-rc.1"]))
      .toThrow("at least rc.1 and rc.2");
    expect(() => assertGaReleaseCandidateSequence(["1.0.0-rc.1", "1.0.0-rc.3"]))
      .toThrow("contiguous sequence");
  });

  test("records failed immutable attempts without counting them as passing candidates", () => {
    expect(parseGaReleaseCandidateRecord(failedEvidence())).toEqual(failedEvidence());
    expect(parseGaFailedReleaseCandidateEvidence(failedEvidence()).provenance).toBe("not-published");
    expect(() => parseGaFailedReleaseCandidateEvidence({
      ...failedEvidence(),
      publishedAt: "2026-08-23T23:54:37Z"
    })).toThrow("must not claim publication");
    expect(() => assertAtLeastTwoPassingGaReleaseCandidates([secondEvidence()]))
      .toThrow("at least two passing release candidates");
    expect(() => assertAtLeastTwoPassingGaReleaseCandidates([evidence(), secondEvidence()]))
      .not.toThrow();
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
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      expectedModels(candidates)
    )).toHaveLength(6);
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      results.slice(0, 3),
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      expectedModels(candidates)
    )).toThrow("exactly 3 providers per release candidate");

    for (const result of results.slice(3)) result.sourceCommit = candidates[0]!.sourceCommit;
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      expectedModels(candidates)
    )).toThrow("sourceCommit differs from its release candidate");

    const substitutedModel = evaluationResults(candidates);
    substitutedModel[1]!.model = "qwen-substituted";
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      substitutedModel,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      expectedModels(candidates)
    )).toThrow("model differs from its external pin");
  });

  test("requires every declared scenario and verifies the candidate workflow runs", async () => {
    const candidates = [evidence(), secondEvidence()];
    const results = evaluationResults(candidates);
    results[0]!.cases = results[0]!.cases.slice(1);
    results[0]!.totalRuns -= 1;
    results[0]!.passedRuns -= 1;
    expect(() => parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      expectedModels(candidates)
    )).toThrow("Too small");

    const completeResults = evaluationResults(candidates);
    await expect(verifyGaRepresentativeEvaluationWorkflows(candidates, completeResults, {
      fetchJson: async (url) => {
        const runId = url.slice(url.lastIndexOf("/") + 1);
        const candidateIndex = candidates.findIndex((candidate) => candidate.workflowUrl.endsWith(`/${runId}`));
        const candidate = candidates[candidateIndex]!;
        return {
          html_url: completeResults[candidateIndex * 3]!.workflowRunUrl,
          head_sha: candidate.sourceCommit,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          path: ".github/workflows/release.yml"
        };
      }
    })).resolves.toBeUndefined();

    await expect(verifyGaRepresentativeEvaluationWorkflows(candidates, completeResults, {
      fetchJson: async () => ({
        html_url: completeResults[0]!.workflowRunUrl,
        head_sha: candidates[0]!.sourceCommit,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        path: ".github/workflows/ci.yml"
      })
    })).rejects.toThrow("unexpected workflow");
  });

  test("allows an explicitly repinned provider cohort in a later RC", () => {
    const candidates = [evidence(), secondEvidence()];
    const results = evaluationResults(candidates);
    const pins = expectedModels(candidates);
    for (const result of results.filter((entry) => entry.releaseTag === candidates[1]!.tag)) {
      result.model = `${result.provider}-corrected`;
    }
    pins[1]!.models = {
      meta: "meta-corrected",
      qwen: "qwen-corrected",
      openai: "openai-corrected"
    };

    expect(parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      pins
    )).toHaveLength(6);
  });

  test("filters the separately pinned stable release while validating recorded RC evidence", () => {
    const candidates = [evidence(), secondEvidence()];
    const results = evaluationResults(candidates);
    const pins = [
      ...expectedModels(candidates),
      {
        releaseTag: "v1.0.0",
        models: { meta: "meta-stable", qwen: "qwen-stable", openai: "openai-stable" }
      }
    ];

    expect(parseGaRepresentativeEvaluationCoverage(
      candidates,
      results,
      GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
      GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
      expectedCases,
      pins
    )).toHaveLength(6);
  });

  test("requires security review evidence under the dedicated review directory", () => {
    expect(parseGaSecurityReviewEvidencePath("security-reviews/1.0.0.json"))
      .toBe("security-reviews/1.0.0.json");
    expect(() => parseGaSecurityReviewEvidencePath("")).toThrow("under security-reviews");
    expect(() => parseGaSecurityReviewEvidencePath("docs/GA_READINESS.md"))
      .toThrow("under security-reviews");
  });
});
