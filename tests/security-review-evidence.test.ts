import { describe, expect, test } from "bun:test";

import {
  SECURITY_CONTROL_MAP,
  SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS,
  SECURITY_REVIEW_TRUST_BOUNDARIES,
  securityReviewRequestHeaders,
  validateSecurityReviewEvidence,
  verifySecurityReviewWorkflowEvidence,
  type SecurityReviewEvidence,
  type SecurityReviewReleaseBinding
} from "../scripts/security-review-evidence.js";
import { createExecutionEnvironmentTools, createWorkspaceTools } from "../src/harness.js";
import { HARNESS_SUBAGENT_PROFILE_DESCRIPTORS } from "../src/orchestration.js";

const binding = {
  releaseTag: "v1.0.0-rc.1",
  sourceCommit: "a".repeat(40),
  artifactSha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`
} satisfies SecurityReviewReleaseBinding;

const workflowEvidence = (
  run: number,
  selectedBinding: SecurityReviewReleaseBinding = binding
) => ({
  workflowUrl: `https://github.com/Zhivex/zhivex-harness/actions/runs/${run}`,
  releaseTag: selectedBinding.releaseTag,
  sourceCommit: selectedBinding.sourceCommit,
  conclusion: "success" as const
});

const validEvidence = (
  selectedBinding: SecurityReviewReleaseBinding = binding
): SecurityReviewEvidence => ({
  schemaVersion: 1,
  kind: "harness-security-review-evidence",
  ...selectedBinding,
  reviewer: {
    name: "Security Reviewer",
    identity: "https://github.com/security-reviewer"
  },
  observedAt: "2026-08-23T23:00:00.000Z",
  status: "passed",
  evidence: {
    ci: workflowEvidence(32670000001, selectedBinding),
    codeql: workflowEvidence(32670000002, selectedBinding),
    dependencyAudit: workflowEvidence(32670000003, selectedBinding),
    release: workflowEvidence(32670000003, selectedBinding),
    provenance: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/security-review-fixture",
      ...selectedBinding,
      status: "verified"
    },
    oci: workflowEvidence(32670000003, selectedBinding)
  },
  findings: [{
    id: "medium-observation",
    severity: "medium",
    status: "open",
    title: "Documented non-blocking residual observation",
    owner: "security-reviewer",
    disposition: "accepted",
    rationale: "The reviewed residual risk is accepted for this release candidate.",
    followUpUrl: "https://github.com/Zhivex/zhivex-harness/issues/100",
    controlThreats: ["compromised-host-kernel-or-daemon"]
  }],
  coverage: {
    controls: SECURITY_CONTROL_MAP.controls.map((control) => ({
      threat: control.threat,
      mitigations: [...control.mitigations],
      regressionEvidence: [...control.evidence],
      residualRisk: control.residualRisk,
      status: "passed" as const
    })),
    trustBoundaries: SECURITY_REVIEW_TRUST_BOUNDARIES.map((boundary) => ({
      id: boundary.id,
      controlThreats: [...boundary.controlThreats],
      mitigations: ["Reviewer confirmed the mapped control mitigations at this boundary."],
      regressionEvidence: ["contracts/security-controls.json"],
      residualRisk: "Reviewer confirmed the mapped residual risk at this boundary.",
      status: "passed" as const
    })),
    authorityBearingTools: SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS.map((tool) => ({
      id: tool.id,
      controlThreats: [...tool.controlThreats],
      mitigations: ["Reviewer confirmed the mapped control mitigations for this tool."],
      regressionEvidence: ["tests/security.test.ts"],
      residualRisk: "Reviewer confirmed the mapped residual risk for this tool.",
      status: "passed" as const
    }))
  }
});

const copy = (selectedBinding: SecurityReviewReleaseBinding = binding) =>
  structuredClone(validEvidence(selectedBinding));

const workflowDocument = (
  review: SecurityReviewEvidence,
  workflowUrl: string,
  overrides: Record<string, unknown> = {}
) => {
  const isCi = workflowUrl === review.evidence.ci.workflowUrl;
  const isCodeql = workflowUrl === review.evidence.codeql.workflowUrl;
  return {
    html_url: workflowUrl,
    head_sha: review.sourceCommit,
    status: "completed",
    conclusion: "success",
    path: isCi
      ? ".github/workflows/ci.yml"
      : isCodeql
        ? ".github/workflows/codeql.yml"
        : ".github/workflows/release.yml",
    event: isCi || isCodeql ? "push" : "workflow_dispatch",
    ...overrides
  };
};

const provenanceStatement = (review: SecurityReviewEvidence) => ({
  subject: [{
    name: `package/zhivex-ai-harness-${review.releaseTag.slice(1)}.tgz`,
    digest: {
      sha512: Buffer.from(
        review.artifactSha512.slice("sha512-".length),
        "base64"
      ).toString("hex")
    }
  }],
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: "https://github.com/Zhivex/zhivex-harness",
          path: ".github/workflows/release.yml",
          ref: `refs/tags/${review.releaseTag}`
        }
      },
      resolvedDependencies: [{ digest: { gitCommit: review.sourceCommit } }]
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: { invocationId: `${review.evidence.release.workflowUrl}/attempts/1` }
    }
  }
});

const workflowFetcher = (
  review: SecurityReviewEvidence,
  mutate: (
    workflowUrl: string,
    workflow: Record<string, unknown>
  ) => Record<string, unknown> = (_workflowUrl, workflow) => workflow,
  calls: string[] = []
) => async (apiUrl: string) => {
  calls.push(apiUrl);
  if (apiUrl === "https://registry.npmjs.org/%40zhivex-ai%2Fharness") {
    return {
      versions: {
        [review.releaseTag.slice(1)]: {
          dist: {
            integrity: review.artifactSha512,
            attestations: {
              url: review.evidence.provenance.url,
              provenance: { predicateType: "https://slsa.dev/provenance/v1" }
            }
          }
        }
      }
    };
  }
  if (apiUrl === review.evidence.provenance.url) {
    return {
      attestations: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(provenanceStatement(review))).toString("base64")
          }
        }
      }]
    };
  }
  const runId = apiUrl.slice(apiUrl.lastIndexOf("/") + 1);
  const workflowUrl = `https://github.com/Zhivex/zhivex-harness/actions/runs/${runId}`;
  return mutate(workflowUrl, workflowDocument(review, workflowUrl));
};

describe("strict security review evidence", () => {
  test("keeps the authority inventory synchronized with every model-facing tool class", () => {
    const actualTools = [
      ...Object.keys(createWorkspaceTools({} as never, [])),
      ...Object.keys(createExecutionEnvironmentTools({} as never, { shellMode: "ask" } as never)),
      "load_skill",
      ...HARNESS_SUBAGENT_PROFILE_DESCRIPTORS.map((profile) => profile.toolName),
      "mcp-network-tool"
    ];
    expect([...new Set(SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS.map((tool) => tool.id))].sort())
      .toEqual([...new Set(actualTools)].sort());
  });

  test("sends the GitHub token only to the exact GitHub API origin", () => {
    expect(securityReviewRequestHeaders(
      "https://api.github.com/repos/Zhivex/zhivex-harness/actions/runs/1",
      "fixture-token"
    )).toHaveProperty("authorization", "Bearer fixture-token");
    expect(securityReviewRequestHeaders(
      "https://registry.npmjs.org/%40zhivex-ai%2Fharness",
      "fixture-token"
    )).not.toHaveProperty("authorization");
    expect(securityReviewRequestHeaders(
      "https://api.github.com.evil.example/attestations/1",
      "fixture-token"
    )).not.toHaveProperty("authorization");
  });

  test("accepts one exact release-bound review with complete control coverage", () => {
    expect(validateSecurityReviewEvidence(validEvidence(), binding)).toMatchObject({
      releaseTag: binding.releaseTag,
      sourceCommit: binding.sourceCommit,
      artifactSha512: binding.artifactSha512,
      status: "passed"
    });
  });

  test("accepts any positive 1.0 release candidate ordinal and rejects invalid forms", () => {
    const laterBinding = {
      ...binding,
      releaseTag: "v1.0.0-rc.37"
    } satisfies SecurityReviewReleaseBinding;
    expect(validateSecurityReviewEvidence(validEvidence(laterBinding), laterBinding).releaseTag)
      .toBe("v1.0.0-rc.37");

    for (const releaseTag of [
      "v1.0.0-rc.0",
      "v1.0.0-rc.01",
      "v1.0.0",
      "v1.0.1-rc.1"
    ]) {
      expect(() => validateSecurityReviewEvidence({
        ...validEvidence(),
        releaseTag
      }, binding), releaseTag).toThrow("positive v1.0.0 release candidate tag");
    }
  });

  test("rejects unknown keys at the root and in nested evidence", () => {
    expect(() => validateSecurityReviewEvidence({
      ...validEvidence(),
      unexpected: true
    }, binding)).toThrow();

    const nested = copy() as SecurityReviewEvidence & {
      reviewer: SecurityReviewEvidence["reviewer"] & { email?: string };
    };
    nested.reviewer.email = "reviewer@example.com";
    expect(() => validateSecurityReviewEvidence(nested, binding)).toThrow();
  });

  test("rejects candidate and workflow binding drift", () => {
    for (const [field, value] of [
      ["releaseTag", "v1.0.0-rc.2"],
      ["sourceCommit", "b".repeat(40)],
      ["artifactSha512", `sha512-${Buffer.alloc(64, 2).toString("base64")}`]
    ] as const) {
      const review = copy();
      Object.assign(review, { [field]: value });
      expect(() => validateSecurityReviewEvidence(review, binding), field).toThrow(`security review ${field}`);
    }

    const workflowDrift = copy();
    workflowDrift.evidence.codeql.sourceCommit = "b".repeat(40);
    expect(() => validateSecurityReviewEvidence(workflowDrift, binding))
      .toThrow("codeql sourceCommit differs from the review");

    const provenanceDrift = copy();
    provenanceDrift.evidence.provenance.artifactSha512 = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
    expect(() => validateSecurityReviewEvidence(provenanceDrift, binding))
      .toThrow("provenance artifactSha512 differs from the review");
  });

  test("requires a reviewer, canonical date, and every evidence class", () => {
    const badDate = copy();
    badDate.observedAt = "2026-08-23";
    expect(() => validateSecurityReviewEvidence(badDate, binding)).toThrow("canonical UTC timestamp");

    const missingLink = copy() as unknown as { evidence: Record<string, unknown> };
    delete missingLink.evidence.dependencyAudit;
    expect(() => validateSecurityReviewEvidence(missingLink, binding)).toThrow();

    const anonymous = copy();
    anonymous.reviewer.name = "";
    expect(() => validateSecurityReviewEvidence(anonymous, binding)).toThrow();
  });

  test("rejects open critical or high findings while retaining lower-severity inventory", () => {
    for (const severity of ["critical", "high"] as const) {
      const review = copy();
      review.findings = [{
        id: `${severity}-finding`,
        severity,
        status: "open",
        title: "Blocking finding",
        owner: "security-reviewer",
        disposition: "mitigated",
        rationale: "Fixture mitigation remains open to exercise the blocking severity rule.",
        followUpUrl: "https://github.com/Zhivex/zhivex-harness/issues/101",
        controlThreats: ["supply-chain-substitution"]
      }];
      expect(() => validateSecurityReviewEvidence(review, binding))
        .toThrow("cannot pass with open critical/high findings");
    }

    expect(validateSecurityReviewEvidence(validEvidence(), binding).findings[0]?.severity).toBe("medium");
  });

  test("never permits critical or high findings to pass by acceptance alone", () => {
    const review = copy();
    review.findings = [{
      id: "accepted-high-finding",
      severity: "high",
      status: "resolved",
      title: "A high finding cannot be waived",
      owner: "security-reviewer",
      disposition: "accepted",
      rationale: "This fixture must be rejected even with an explicit rationale.",
      followUpUrl: "https://github.com/Zhivex/zhivex-harness/issues/102",
      controlThreats: ["supply-chain-substitution"]
    }];
    expect(() => validateSecurityReviewEvidence(review, binding))
      .toThrow("critical/high findings cannot be accepted");
  });

  test("requires ownership, disposition, rationale, and follow-up for actionable findings", () => {
    for (const field of ["owner", "disposition", "rationale", "followUpUrl"] as const) {
      const review = copy();
      delete review.findings[0]![field];
      expect(() => validateSecurityReviewEvidence(review, binding), field)
        .toThrow(`${field} is required for non-informational findings`);
    }
  });

  test("requires direct mitigation, regression, residual-risk, and status coverage for boundaries and tools", () => {
    for (const collection of ["trustBoundaries", "authorityBearingTools"] as const) {
      const review = copy();
      const entry = review.coverage[collection][0]! as Record<string, unknown>;
      delete entry.regressionEvidence;
      expect(() => validateSecurityReviewEvidence(review, binding), collection).toThrow();
    }
  });

  test("rejects missing, unknown, or drifted control-map coverage", () => {
    const missingBoundary = copy();
    missingBoundary.coverage.trustBoundaries.pop();
    expect(() => validateSecurityReviewEvidence(missingBoundary, binding))
      .toThrow("trust boundaries IDs must match the required inventory exactly");

    const missingTool = copy();
    missingTool.coverage.authorityBearingTools.pop();
    expect(() => validateSecurityReviewEvidence(missingTool, binding))
      .toThrow("authority-bearing tools IDs must match the required inventory exactly");

    const driftedMitigation = copy();
    driftedMitigation.coverage.controls[0]!.mitigations = ["unreviewed replacement"];
    expect(() => validateSecurityReviewEvidence(driftedMitigation, binding))
      .toThrow("mitigations must match the required inventory exactly");

    const unknownFindingControl = copy();
    unknownFindingControl.findings[0]!.controlThreats = ["unknown-threat"];
    expect(() => validateSecurityReviewEvidence(unknownFindingControl, binding))
      .toThrow("references unknown control unknown-threat");
  });

  test("rejects drift in regression evidence and residual risk", () => {
    const regressionDrift = copy();
    regressionDrift.coverage.controls[0]!.regressionEvidence = ["tests/unrelated.test.ts"];
    expect(() => validateSecurityReviewEvidence(regressionDrift, binding))
      .toThrow("regression evidence must match the required inventory exactly");

    const residualRiskDrift = copy();
    residualRiskDrift.coverage.controls[0]!.residualRisk = "No remaining risk.";
    expect(() => validateSecurityReviewEvidence(residualRiskDrift, binding))
      .toThrow("residual risk differs from the control map");
  });

  test("verifies workflow identity and completion while reusing one release run", async () => {
    const review = validEvidence();
    const calls: string[] = [];

    await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
      fetchJson: workflowFetcher(review, undefined, calls)
    })).resolves.toEqual(review);

    expect(calls).toHaveLength(5);
    expect(new Set(calls).size).toBe(5);
    expect(calls).toContain(
      "https://api.github.com/repos/Zhivex/zhivex-harness/actions/runs/32670000003"
    );
  });

  test("binds provenance to npm registry metadata, artifact bytes, and the release workflow", async () => {
    const review = validEvidence();
    const validFetch = workflowFetcher(review);
    await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
      fetchJson: async (url) => {
        if (url === "https://registry.npmjs.org/%40zhivex-ai%2Fharness") {
          return {
            versions: {
              [review.releaseTag.slice(1)]: {
                dist: {
                  integrity: review.artifactSha512,
                  attestations: {
                    url: "https://registry.npmjs.org/-/npm/v1/attestations/another-artifact",
                    provenance: { predicateType: "https://slsa.dev/provenance/v1" }
                  }
                }
              }
            }
          };
        }
        return validFetch(url);
      }
    })).rejects.toThrow("provenance URL differs from npm registry metadata");

    await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
      fetchJson: async (url) => {
        if (url === "https://registry.npmjs.org/%40zhivex-ai%2Fharness") {
          return {
            versions: {
              [review.releaseTag.slice(1)]: {
                dist: {
                  integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}`,
                  attestations: {
                    url: review.evidence.provenance.url,
                    provenance: { predicateType: "https://slsa.dev/provenance/v1" }
                  }
                }
              }
            }
          };
        }
        return validFetch(url);
      }
    })).rejects.toThrow("artifact differs from npm registry integrity");

    await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
      fetchJson: async (url) => {
        if (url === review.evidence.provenance.url) {
          const statement = provenanceStatement(review);
          statement.predicate.runDetails.metadata.invocationId =
            "https://github.com/Zhivex/zhivex-harness/actions/runs/999/attempts/1";
          return {
            attestations: [{
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from(JSON.stringify(statement)).toString("base64")
                }
              }
            }]
          };
        }
        return validFetch(url);
      }
    })).rejects.toThrow("provenance invocation differs from its release workflow");
  });

  test("rejects GitHub workflow URL, commit, status, or conclusion drift", async () => {
    const review = validEvidence();
    const cases = [
      ["html_url", "https://github.com/Zhivex/zhivex-harness/actions/runs/999", "workflow URL differs from GitHub"],
      ["head_sha", "b".repeat(40), "workflow commit differs from the security review"],
      ["status", "in_progress", "workflow has not completed"],
      ["conclusion", "failure", "workflow did not succeed"]
    ] as const;

    for (const [field, value, message] of cases) {
      await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
        fetchJson: workflowFetcher(review, (workflowUrl, workflow) =>
          workflowUrl === review.evidence.ci.workflowUrl
            ? { ...workflow, [field]: value }
            : workflow)
      }), field).rejects.toThrow(`ci ${message}`);
    }
  });

  test("rejects wrong workflow paths and trigger events for every workflow class", async () => {
    const review = validEvidence();
    const cases = [
      [review.evidence.ci.workflowUrl, "path", ".github/workflows/release.yml", "ci evidence used an unexpected workflow"],
      [review.evidence.ci.workflowUrl, "event", "pull_request", "ci workflow used an unexpected event"],
      [review.evidence.codeql.workflowUrl, "path", ".github/workflows/ci.yml", "codeql evidence used an unexpected workflow"],
      [review.evidence.codeql.workflowUrl, "event", "pull_request", "codeql workflow used an unexpected event"],
      [review.evidence.release.workflowUrl, "path", ".github/workflows/ci.yml", "dependencyAudit evidence used an unexpected workflow"],
      [review.evidence.release.workflowUrl, "event", "push", "dependencyAudit workflow used an unexpected event"]
    ] as const;

    for (const [targetUrl, field, value, message] of cases) {
      await expect(verifySecurityReviewWorkflowEvidence(review, binding, {
        fetchJson: workflowFetcher(review, (workflowUrl, workflow) =>
          workflowUrl === targetUrl ? { ...workflow, [field]: value } : workflow)
      }), `${targetUrl} ${field}`).rejects.toThrow(message);
    }
  });
});
