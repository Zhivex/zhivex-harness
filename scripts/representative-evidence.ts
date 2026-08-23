import { z } from "zod";

export const REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION = 2 as const;

export const REPRESENTATIVE_EVIDENCE_PROVIDERS = ["meta", "qwen", "openai"] as const;

export const REPRESENTATIVE_EVIDENCE_SCENARIOS = [
  "typescript-node-package",
  "json-cli-contract",
  "sqlite-restart-and-resume",
  "target-package-managers",
  "python-pytest-repository",
  "hostile-instructions",
  "concurrent-change-conflict"
] as const;

const releaseTagSchema = z.string().regex(
  /^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/,
  "release tag must be an annotated-style vX.Y.Z or vX.Y.Z-rc.N identifier"
);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/, "commit must be a full lowercase Git SHA");
const artifactSha512Schema = z.string()
  .regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/, "artifactSha512 must use npm sha512 integrity syntax")
  .refine((value) => {
    try {
      return Buffer.from(value.slice("sha512-".length), "base64").byteLength === 64;
    } catch {
      return false;
    }
  }, "artifactSha512 must decode to exactly 64 bytes");
const ociImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workflowRunUrlSchema = z.string().regex(
  /^https:\/\/github\.com\/Zhivex\/zhivex-harness\/actions\/runs\/[1-9]\d*$/
);
const boundedIdentifierSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/);
const caseIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:|+-]*$/);
const timestampSchema = z.iso.datetime({ offset: true });
const countSchema = z.number().int().nonnegative();

const expectedCaseSchema = z.object({
  caseId: caseIdentifierSchema,
  scenarioId: z.enum(REPRESENTATIVE_EVIDENCE_SCENARIOS)
}).strict();

const representativeProviderModelsSchema = z.object({
  meta: boundedIdentifierSchema,
  qwen: boundedIdentifierSchema,
  openai: boundedIdentifierSchema
}).strict();

export const representativeModelPinSchema = z.object({
  releaseTag: releaseTagSchema,
  models: representativeProviderModelsSchema
}).strict();

const caseResultSchema = z.object({
  caseId: caseIdentifierSchema,
  scenarioId: z.enum(REPRESENTATIVE_EVIDENCE_SCENARIOS),
  runId: caseIdentifierSchema,
  status: z.enum(["passed", "failed", "omitted"]),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  durationMs: countSchema
}).strict();

export const representativeProviderResultSchema = z.object({
  releaseTag: releaseTagSchema,
  sourceCommit: commitSchema,
  artifactSha512: artifactSha512Schema,
  datasetRevision: boundedIdentifierSchema,
  driverCommit: commitSchema,
  ociImageDigest: ociImageDigestSchema,
  workflowRunUrl: workflowRunUrlSchema,
  provider: z.enum(REPRESENTATIVE_EVIDENCE_PROVIDERS),
  model: boundedIdentifierSchema,
  observedAt: timestampSchema,
  cases: z.array(caseResultSchema).min(REPRESENTATIVE_EVIDENCE_SCENARIOS.length),
  totalRuns: countSchema,
  passedRuns: countSchema,
  failedRuns: countSchema,
  omittedRuns: countSchema
}).strict();

export const representativeEvidenceSchema = z.object({
  schemaVersion: z.literal(REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION),
  kind: z.literal("harness-representative-evaluation-evidence"),
  releaseTags: z.array(releaseTagSchema).min(1),
  expectedModels: z.array(representativeModelPinSchema).min(1),
  expectedCases: z.array(expectedCaseSchema).min(REPRESENTATIVE_EVIDENCE_SCENARIOS.length),
  results: z.array(representativeProviderResultSchema).min(REPRESENTATIVE_EVIDENCE_PROVIDERS.length)
}).strict();

export type RepresentativeEvidence = z.infer<typeof representativeEvidenceSchema>;
export type RepresentativeProviderResult = z.infer<typeof representativeProviderResultSchema>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Representative evidence is invalid: ${message}`);
}

const unique = (values: readonly string[], label: string) => {
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
};

const sameStringSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value) => right.includes(value));

const validateExpectedCases = (evidence: RepresentativeEvidence) => {
  const expectedCaseIds = evidence.expectedCases.map((entry) => entry.caseId);
  unique(expectedCaseIds, "expectedCases.caseId");

  const declaredScenarios = new Set(evidence.expectedCases.map((entry) => entry.scenarioId));
  assert(
    declaredScenarios.size === REPRESENTATIVE_EVIDENCE_SCENARIOS.length &&
      REPRESENTATIVE_EVIDENCE_SCENARIOS.every((scenario) => declaredScenarios.has(scenario)),
    "expectedCases must cover all seven exact scenario IDs"
  );

  return new Map(evidence.expectedCases.map((entry) => [entry.caseId, entry.scenarioId]));
};

const validateCaseResults = (
  result: RepresentativeProviderResult,
  expectedCases: ReadonlyMap<string, (typeof REPRESENTATIVE_EVIDENCE_SCENARIOS)[number]>
) => {
  const caseIds = result.cases.map((entry) => entry.caseId);
  const expectedCaseIds = [...expectedCases.keys()];
  unique(caseIds, `${result.releaseTag}/${result.provider} cases`);
  assert(
    sameStringSet(caseIds, expectedCaseIds),
    `${result.releaseTag}/${result.provider} must contain every expected case exactly once`
  );

  let latestCompletion = Number.NEGATIVE_INFINITY;
  const runIds: string[] = [];
  for (const entry of result.cases) {
    assert(
      expectedCases.get(entry.caseId) === entry.scenarioId,
      `${result.releaseTag}/${result.provider}/${entry.caseId} changed scenario identity`
    );
    const startedAt = Date.parse(entry.startedAt);
    const completedAt = Date.parse(entry.completedAt);
    assert(completedAt >= startedAt, `${result.releaseTag}/${result.provider}/${entry.caseId} completed before it started`);
    assert(
      entry.durationMs === completedAt - startedAt,
      `${result.releaseTag}/${result.provider}/${entry.caseId} durationMs is not derived from its timestamps`
    );
    latestCompletion = Math.max(latestCompletion, completedAt);
    runIds.push(entry.runId);
  }
  unique(runIds, `${result.releaseTag}/${result.provider} runId`);
  assert(
    Date.parse(result.observedAt) >= latestCompletion,
    `${result.releaseTag}/${result.provider} observedAt precedes a completed case`
  );

  const derived = {
    totalRuns: result.cases.length,
    passedRuns: result.cases.filter((entry) => entry.status === "passed").length,
    failedRuns: result.cases.filter((entry) => entry.status === "failed").length,
    omittedRuns: result.cases.filter((entry) => entry.status === "omitted").length
  };
  for (const field of ["totalRuns", "passedRuns", "failedRuns", "omittedRuns"] as const) {
    assert(
      result[field] === derived[field],
      `${result.releaseTag}/${result.provider} ${field} differs from individual cases`
    );
  }
  assert(result.totalRuns === expectedCases.size, `${result.releaseTag}/${result.provider} run count is incomplete`);
  assert(result.failedRuns === 0, `${result.releaseTag}/${result.provider} contains failed runs`);
  assert(result.omittedRuns === 0, `${result.releaseTag}/${result.provider} contains omitted runs`);
};

const sharedProviderFields = [
  "releaseTag",
  "sourceCommit",
  "artifactSha512",
  "datasetRevision",
  "driverCommit",
  "ociImageDigest",
  "workflowRunUrl"
] as const satisfies readonly (keyof RepresentativeProviderResult)[];

/**
 * Validate complete, sanitized representative evidence for every externally
 * declared release candidate. The expected RC list is intentionally supplied by
 * the caller so omitting an entire candidate cannot be hidden by the evidence.
 */
export const validateRepresentativeEvidence = (
  input: unknown,
  expectedReleaseTags: readonly string[]
): RepresentativeEvidence => {
  const parsedExpectedReleaseTags = z.array(releaseTagSchema).min(1).parse(expectedReleaseTags);
  unique(parsedExpectedReleaseTags, "expected release candidates");
  const evidence = representativeEvidenceSchema.parse(input);
  unique(evidence.releaseTags, "releaseTags");
  assert(
    sameStringSet(evidence.releaseTags, parsedExpectedReleaseTags),
    "releaseTags must match every externally declared release candidate"
  );
  const modelPinReleaseTags = evidence.expectedModels.map((pin) => pin.releaseTag);
  unique(modelPinReleaseTags, "expectedModels.releaseTag");
  assert(
    sameStringSet(modelPinReleaseTags, evidence.releaseTags),
    "expectedModels must pin every declared release candidate exactly once"
  );

  const expectedCases = validateExpectedCases(evidence);
  assert(
    evidence.results.length === evidence.releaseTags.length * REPRESENTATIVE_EVIDENCE_PROVIDERS.length,
    `results must contain exactly ${REPRESENTATIVE_EVIDENCE_PROVIDERS.length} providers per release candidate`
  );

  const workflowOwners = new Map<string, string>();
  for (const releaseTag of evidence.releaseTags) {
    const results = evidence.results.filter((result) => result.releaseTag === releaseTag);
    const providers = results.map((result) => result.provider);
    unique(providers, `${releaseTag} providers`);
    assert(
      sameStringSet(providers, REPRESENTATIVE_EVIDENCE_PROVIDERS),
      `${releaseTag} must contain exactly meta, qwen, and openai`
    );

    const reference = results[0]!;
    const expectedModels = evidence.expectedModels.find((pin) => pin.releaseTag === releaseTag)!.models;
    for (const result of results) {
      for (const field of sharedProviderFields) {
        assert(
          result[field] === reference[field],
          `${releaseTag} providers disagree on ${field}`
        );
      }
      assert(
        result.model === expectedModels[result.provider],
        `${releaseTag}/${result.provider} model differs from its external pin`
      );
      validateCaseResults(result, expectedCases);
    }

    const previousOwner = workflowOwners.get(reference.workflowRunUrl);
    assert(
      previousOwner === undefined || previousOwner === releaseTag,
      `${reference.workflowRunUrl} is reused across release candidates`
    );
    workflowOwners.set(reference.workflowRunUrl, releaseTag);
  }

  const unknownReleaseTags = evidence.results
    .map((result) => result.releaseTag)
    .filter((releaseTag) => !evidence.releaseTags.includes(releaseTag));
  assert(unknownReleaseTags.length === 0, "results contain an undeclared release candidate");
  return evidence;
};
