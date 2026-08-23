import { describe, expect, test } from "bun:test";

import {
  REPRESENTATIVE_EVIDENCE_PROVIDERS,
  REPRESENTATIVE_EVIDENCE_SCENARIOS,
  validateRepresentativeEvidence
} from "../scripts/representative-evidence.js";

const artifactSha512 = (byte: number) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;

const expectedCases = REPRESENTATIVE_EVIDENCE_SCENARIOS.map((scenarioId, index) => ({
  caseId: `case-${index + 1}`,
  scenarioId
}));

const providerResult = (
  releaseNumber: number,
  provider: (typeof REPRESENTATIVE_EVIDENCE_PROVIDERS)[number]
) => {
  const minute = String(releaseNumber).padStart(2, "0");
  const cases = expectedCases.map((entry, index) => ({
    ...entry,
    runId: `${provider}-run-${releaseNumber}-${index + 1}`,
    status: "passed" as "passed" | "failed" | "omitted",
    startedAt: `2026-08-23T12:${minute}:${String(index).padStart(2, "0")}.000Z`,
    completedAt: `2026-08-23T12:${minute}:${String(index).padStart(2, "0")}.250Z`,
    durationMs: 250
  }));
  return {
    releaseTag: `v1.0.0-rc.${releaseNumber}`,
    sourceCommit: String(releaseNumber).repeat(40),
    artifactSha512: artifactSha512(releaseNumber),
    datasetRevision: "representative-v1",
    driverCommit: "d".repeat(40),
    ociImageDigest: `sha256:${"e".repeat(64)}`,
    workflowRunUrl: `https://github.com/Zhivex/zhivex-harness/actions/runs/32195816${releaseNumber}`,
    provider,
    model: `${provider}-fixture`,
    observedAt: `2026-08-23T12:${minute}:30.000Z`,
    cases,
    totalRuns: cases.length,
    passedRuns: cases.length,
    failedRuns: 0,
    omittedRuns: 0
  };
};

const evidence = (releaseNumbers: readonly number[] = [1, 2, 3]) => ({
  schemaVersion: 2 as const,
  kind: "harness-representative-evaluation-evidence" as const,
  releaseTags: releaseNumbers.map((number) => `v1.0.0-rc.${number}`),
  expectedModels: releaseNumbers.map((number) => ({
    releaseTag: `v1.0.0-rc.${number}`,
    models: {
      meta: "meta-fixture",
      qwen: "qwen-fixture",
      openai: "openai-fixture"
    }
  })),
  expectedCases: expectedCases.map((entry) => ({ ...entry })),
  results: releaseNumbers.flatMap((releaseNumber) =>
    REPRESENTATIVE_EVIDENCE_PROVIDERS.map((provider) => providerResult(releaseNumber, provider))
  )
});

const clone = <T>(value: T): T => structuredClone(value);

describe("strict representative evaluation evidence", () => {
  test("accepts every externally declared RC without hardcoding rc.1 and rc.2", () => {
    const document = evidence([1, 2, 3]);

    expect(validateRepresentativeEvidence(document, document.releaseTags)).toEqual(document);
  });

  test("allows each RC to pin corrected dataset, driver, image, and provider models", () => {
    const document = evidence([1, 2]);
    for (const result of document.results.filter((entry) => entry.releaseTag === "v1.0.0-rc.2")) {
      result.datasetRevision = "representative-v2";
      result.driverCommit = "f".repeat(40);
      result.ociImageDigest = `sha256:${"a".repeat(64)}`;
      result.model = `${result.provider}-corrected-fixture`;
    }
    document.expectedModels[1]!.models = {
      meta: "meta-corrected-fixture",
      qwen: "qwen-corrected-fixture",
      openai: "openai-corrected-fixture"
    };

    expect(validateRepresentativeEvidence(document, document.releaseTags)).toEqual(document);
  });

  test("rejects a self-declared model that differs from the external candidate pin", () => {
    const document = evidence([1]);
    document.results[0]!.model = "meta-substituted";

    expect(() => validateRepresentativeEvidence(document, document.releaseTags))
      .toThrow("model differs from its external pin");
  });

  test("rejects an entire omitted RC and requires the exact provider cohort", () => {
    const missingRc = evidence([1, 2]);
    expect(() => validateRepresentativeEvidence(missingRc, [
      "v1.0.0-rc.1",
      "v1.0.0-rc.2",
      "v1.0.0-rc.3"
    ])).toThrow("every externally declared release candidate");

    const missingProvider = evidence([1]);
    missingProvider.results = missingProvider.results.filter((result) => result.provider !== "qwen");
    expect(() => validateRepresentativeEvidence(missingProvider, missingProvider.releaseTags))
      .toThrow();

    const extraProvider = clone(evidence([1])) as unknown as Record<string, unknown>;
    const results = extraProvider.results as Array<Record<string, unknown>>;
    results.push({ ...results[0]!, provider: "gemini" });
    expect(() => validateRepresentativeEvidence(extraProvider, ["v1.0.0-rc.1"]))
      .toThrow();
  });

  test("requires every individual case and all seven exact scenario IDs", () => {
    const selective = evidence([1]);
    const first = selective.results[0]!;
    first.cases = first.cases.slice(1);
    first.totalRuns = first.cases.length;
    first.passedRuns = first.cases.length;
    expect(() => validateRepresentativeEvidence(selective, selective.releaseTags))
      .toThrow();

    const incompleteScenarios = evidence([1]);
    incompleteScenarios.expectedCases = incompleteScenarios.expectedCases.slice(1);
    expect(() => validateRepresentativeEvidence(incompleteScenarios, incompleteScenarios.releaseTags))
      .toThrow();

    const changedScenario = clone(evidence([1]));
    changedScenario.results[0]!.cases[0]!.scenarioId = "json-cli-contract";
    expect(() => validateRepresentativeEvidence(changedScenario, changedScenario.releaseTags))
      .toThrow("changed scenario identity");
  });

  test("derives counts from cases and fails closed on failed or omitted runs", () => {
    const inconsistent = evidence([1]);
    inconsistent.results[0]!.passedRuns -= 1;
    expect(() => validateRepresentativeEvidence(inconsistent, inconsistent.releaseTags))
      .toThrow("passedRuns differs from individual cases");

    const failed = evidence([1]);
    failed.results[0]!.cases[0]!.status = "failed";
    failed.results[0]!.passedRuns -= 1;
    failed.results[0]!.failedRuns = 1;
    expect(() => validateRepresentativeEvidence(failed, failed.releaseTags))
      .toThrow("contains failed runs");

    const omitted = evidence([1]);
    omitted.results[0]!.cases[0]!.status = "omitted";
    omitted.results[0]!.passedRuns -= 1;
    omitted.results[0]!.omittedRuns = 1;
    expect(() => validateRepresentativeEvidence(omitted, omitted.releaseTags))
      .toThrow("contains omitted runs");
  });

  test.each([
    ["sourceCommit", "f".repeat(40)],
    ["artifactSha512", artifactSha512(9)],
    ["datasetRevision", "representative-v2"],
    ["driverCommit", "f".repeat(40)],
    ["ociImageDigest", `sha256:${"f".repeat(64)}`],
    ["workflowRunUrl", "https://github.com/Zhivex/zhivex-harness/actions/runs/999999999"]
  ] as const)("requires cross-provider equality for %s", (field, value) => {
    const document = evidence([1]);
    document.results[1]![field] = value;

    expect(() => validateRepresentativeEvidence(document, document.releaseTags))
      .toThrow(`providers disagree on ${field}`);
  });

  test("rejects raw prompts, outputs, and every other undeclared key", () => {
    const rawResult = clone(evidence([1])) as unknown as Record<string, unknown>;
    (rawResult.results as Array<Record<string, unknown>>)[0]!.rawOutput = "provider-secret";
    expect(() => validateRepresentativeEvidence(rawResult, ["v1.0.0-rc.1"]))
      .toThrow();

    const rawCase = clone(evidence([1])) as unknown as Record<string, unknown>;
    const result = (rawCase.results as Array<Record<string, unknown>>)[0]!;
    (result.cases as Array<Record<string, unknown>>)[0]!.prompt = "hostile raw prompt";
    expect(() => validateRepresentativeEvidence(rawCase, ["v1.0.0-rc.1"]))
      .toThrow();

    const extraTopLevel = { ...evidence([1]), hostPath: "/private/workspace" };
    expect(() => validateRepresentativeEvidence(extraTopLevel, extraTopLevel.releaseTags))
      .toThrow();
  });

  test("checks timestamp-derived duration and workflow reuse across RCs", () => {
    const wrongDuration = evidence([1]);
    wrongDuration.results[0]!.cases[0]!.durationMs = 249;
    expect(() => validateRepresentativeEvidence(wrongDuration, wrongDuration.releaseTags))
      .toThrow("durationMs is not derived");

    const reusedWorkflow = evidence([1, 2]);
    const firstWorkflow = reusedWorkflow.results[0]!.workflowRunUrl;
    for (const result of reusedWorkflow.results.filter((entry) => entry.releaseTag === "v1.0.0-rc.2")) {
      result.workflowRunUrl = firstWorkflow;
    }
    expect(() => validateRepresentativeEvidence(reusedWorkflow, reusedWorkflow.releaseTags))
      .toThrow("reused across release candidates");
  });
});
