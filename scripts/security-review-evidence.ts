import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  assertReleaseProvenance,
  type ProvenanceStatement
} from "./release-provenance.js";

export const SECURITY_REVIEW_SCHEMA_VERSION = 1 as const;

const PACKAGE_REGISTRY_URL = "https://registry.npmjs.org/%40zhivex-ai%2Fharness";

export const SECURITY_REVIEW_TRUST_BOUNDARIES = [
  {
    id: "operator-approval",
    controlThreats: ["compromised-model-or-provider", "approval-replay-or-substitution"]
  },
  { id: "model-provider", controlThreats: ["compromised-model-or-provider"] },
  { id: "repository-context", controlThreats: ["malicious-repository-context"] },
  { id: "mcp-server", controlThreats: ["hostile-mcp-server"] },
  { id: "target-subprocess", controlThreats: ["hostile-subprocess"] },
  {
    id: "oci-runtime",
    controlThreats: ["hostile-subprocess", "compromised-host-kernel-or-daemon"]
  },
  {
    id: "local-state",
    controlThreats: ["cross-scope-state-access", "crash-or-concurrent-writer"]
  },
  { id: "github-actions", controlThreats: ["supply-chain-substitution"] },
  { id: "npm-registry", controlThreats: ["supply-chain-substitution"] },
  { id: "downstream-consumer", controlThreats: ["supply-chain-substitution"] }
] as const;

export const SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS = [
  {
    id: "apply_patch",
    controlThreats: ["malicious-repository-context", "approval-replay-or-substitution"]
  },
  {
    id: "apply_reviewed_edits",
    controlThreats: ["malicious-repository-context", "approval-replay-or-substitution"]
  },
  {
    id: "move_file",
    controlThreats: ["malicious-repository-context", "approval-replay-or-substitution"]
  },
  {
    id: "quarantine_file",
    controlThreats: ["malicious-repository-context", "approval-replay-or-substitution"]
  },
  {
    id: "restore_file",
    controlThreats: ["malicious-repository-context", "approval-replay-or-substitution"]
  },
  {
    id: "run_check",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "run_environment_command",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "run_environment_batch",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "run_environment_shell",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "apply_environment_patch",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "verify_and_apply_environment_patch",
    controlThreats: ["hostile-subprocess", "approval-replay-or-substitution"]
  },
  {
    id: "verify_and_apply_reviewed_edits",
    controlThreats: [
      "malicious-repository-context",
      "hostile-subprocess",
      "approval-replay-or-substitution"
    ]
  },
  {
    id: "mcp-network-tool",
    controlThreats: ["hostile-mcp-server", "approval-replay-or-substitution"]
  }
] as const;

const nonEmptyString = z.string().trim().min(1).max(2_000);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const releaseTagSchema = z.string().regex(
  /^v1\.0\.0-rc\.[1-9]\d*$/,
  "releaseTag must be a positive v1.0.0 release candidate tag"
);
const canonicalTimestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "observedAt must be a canonical UTC timestamp");
const sha512IntegritySchema = z.string().refine((value) => {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const payload = value.slice("sha512-".length);
  const digest = Buffer.from(payload, "base64");
  return digest.length === 64 && digest.toString("base64") === payload;
}, "artifactSha512 must be one canonical 64-byte SHA-512 integrity value");
const httpsUrlSchema = z.string().url().refine(
  (value) => new URL(value).protocol === "https:",
  "evidence URLs must use HTTPS"
);
const workflowUrlSchema = httpsUrlSchema.regex(
  /^https:\/\/github\.com\/Zhivex\/zhivex-harness\/actions\/runs\/[1-9]\d*$/,
  "workflow evidence must link an exact Zhivex Harness Actions run"
);

const stringSetSchema = z.array(nonEmptyString).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "values must be unique" });
  }
});

const securityControlSchema = z.strictObject({
  threat: identifier,
  mitigations: stringSetSchema,
  evidence: stringSetSchema,
  residualRisk: nonEmptyString
});

const securityControlMapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetVersion: z.literal("1.0.0"),
  controls: z.array(securityControlSchema).min(1)
});

export type SecurityControlMap = z.infer<typeof securityControlMapSchema>;

const securityControlMapPath = fileURLToPath(
  new URL("../contracts/security-controls.json", import.meta.url)
);

export const SECURITY_CONTROL_MAP: SecurityControlMap = securityControlMapSchema.parse(
  JSON.parse(readFileSync(securityControlMapPath, "utf8"))
);

const workflowEvidenceSchema = z.strictObject({
  workflowUrl: workflowUrlSchema,
  releaseTag: releaseTagSchema,
  sourceCommit: commitSchema,
  conclusion: z.literal("success")
});

const provenanceEvidenceSchema = z.strictObject({
  url: httpsUrlSchema,
  releaseTag: releaseTagSchema,
  sourceCommit: commitSchema,
  artifactSha512: sha512IntegritySchema,
  status: z.literal("verified")
});

const findingSchema = z.strictObject({
  id: identifier,
  severity: z.enum(["critical", "high", "medium", "low", "informational"]),
  status: z.enum(["open", "resolved"]),
  title: nonEmptyString,
  controlThreats: z.array(identifier).min(1).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "finding controlThreats must be unique" });
    }
  })
});

const reviewedControlSchema = z.strictObject({
  threat: identifier,
  mitigations: stringSetSchema,
  regressionEvidence: stringSetSchema,
  residualRisk: nonEmptyString,
  status: z.literal("passed")
});

const inventoryCoverageSchema = z.strictObject({
  id: identifier,
  controlThreats: z.array(identifier).min(1).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "coverage controlThreats must be unique" });
    }
  })
});

export const securityReviewEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(SECURITY_REVIEW_SCHEMA_VERSION),
  kind: z.literal("harness-security-review-evidence"),
  releaseTag: releaseTagSchema,
  sourceCommit: commitSchema,
  artifactSha512: sha512IntegritySchema,
  reviewer: z.strictObject({
    name: nonEmptyString,
    identity: httpsUrlSchema
  }),
  observedAt: canonicalTimestampSchema,
  status: z.literal("passed"),
  evidence: z.strictObject({
    ci: workflowEvidenceSchema,
    codeql: workflowEvidenceSchema,
    dependencyAudit: workflowEvidenceSchema,
    release: workflowEvidenceSchema,
    provenance: provenanceEvidenceSchema,
    oci: workflowEvidenceSchema
  }),
  findings: z.array(findingSchema),
  coverage: z.strictObject({
    controls: z.array(reviewedControlSchema).min(1),
    trustBoundaries: z.array(inventoryCoverageSchema).min(1),
    authorityBearingTools: z.array(inventoryCoverageSchema).min(1)
  })
});

export type SecurityReviewEvidence = z.infer<typeof securityReviewEvidenceSchema>;

export interface SecurityReviewReleaseBinding {
  releaseTag: SecurityReviewEvidence["releaseTag"];
  sourceCommit: string;
  artifactSha512: string;
}

interface WorkflowRunDocument {
  html_url?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  path?: string;
  event?: string;
}

interface RegistryDocument {
  versions?: Record<string, {
    dist?: {
      integrity?: string;
      attestations?: {
        url?: string;
        provenance?: { predicateType?: string };
      };
    };
  }>;
}

interface AttestationDocument {
  attestations?: Array<{
    predicateType?: string;
    bundle?: { dsseEnvelope?: { payload?: string } };
  }>;
}

export interface SecurityReviewWorkflowEvidenceDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
}

const workflowExpectations = [
  ["ci", ".github/workflows/ci.yml", "push"],
  ["codeql", ".github/workflows/codeql.yml", "push"],
  ["dependencyAudit", ".github/workflows/release.yml", "workflow_dispatch"],
  ["release", ".github/workflows/release.yml", "workflow_dispatch"],
  ["oci", ".github/workflows/release.yml", "workflow_dispatch"]
] as const;

const object = (input: unknown, label: string): Record<string, unknown> => {
  assert(input && typeof input === "object" && !Array.isArray(input), `${label} must be an object`);
  return input as Record<string, unknown>;
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "cache-control": "no-cache",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
    },
    signal: AbortSignal.timeout(20_000)
  });
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return await response.json();
};

const exactSet = (actual: readonly string[], expected: readonly string[], label: string) => {
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${label} must match the required inventory exactly`
  );
};

const assertUniqueIds = (values: readonly { id: string }[], label: string) => {
  assert.equal(new Set(values.map((value) => value.id)).size, values.length, `${label} IDs must be unique`);
};

const assertInventoryCoverage = (
  actual: readonly { id: string; controlThreats: readonly string[] }[],
  expected: readonly { id: string; controlThreats: readonly string[] }[],
  knownThreats: ReadonlySet<string>,
  label: string
) => {
  assertUniqueIds(actual, label);
  exactSet(actual.map((entry) => entry.id), expected.map((entry) => entry.id), `${label} IDs`);
  for (const expectedEntry of expected) {
    const actualEntry = actual.find((entry) => entry.id === expectedEntry.id)!;
    exactSet(
      actualEntry.controlThreats,
      expectedEntry.controlThreats,
      `${label} ${expectedEntry.id} controls`
    );
    for (const threat of actualEntry.controlThreats) {
      assert(knownThreats.has(threat), `${label} ${expectedEntry.id} references unknown control ${threat}`);
    }
  }
};

export const validateSecurityReviewEvidence = (
  input: unknown,
  expectedBinding: SecurityReviewReleaseBinding,
  controlMapInput: unknown = SECURITY_CONTROL_MAP
): SecurityReviewEvidence => {
  const expected = z.strictObject({
    releaseTag: releaseTagSchema,
    sourceCommit: commitSchema,
    artifactSha512: sha512IntegritySchema
  }).parse(expectedBinding);
  const review = securityReviewEvidenceSchema.parse(input);
  const controlMap = securityControlMapSchema.parse(controlMapInput);

  assert.equal(review.releaseTag, expected.releaseTag, "security review releaseTag differs from the release candidate");
  assert.equal(review.sourceCommit, expected.sourceCommit, "security review sourceCommit differs from the release candidate");
  assert.equal(
    review.artifactSha512,
    expected.artifactSha512,
    "security review artifactSha512 differs from the release candidate"
  );

  const { provenance, ...workflowEvidence } = review.evidence;
  assert.equal(provenance.releaseTag, review.releaseTag, "provenance releaseTag differs from the review");
  assert.equal(provenance.sourceCommit, review.sourceCommit, "provenance sourceCommit differs from the review");
  assert.equal(
    provenance.artifactSha512,
    review.artifactSha512,
    "provenance artifactSha512 differs from the review"
  );
  for (const [name, evidence] of Object.entries(workflowEvidence)) {
    assert.equal(evidence.releaseTag, review.releaseTag, `${name} releaseTag differs from the review`);
    assert.equal(evidence.sourceCommit, review.sourceCommit, `${name} sourceCommit differs from the review`);
  }

  assertUniqueIds(review.findings, "finding inventory");
  assert.equal(
    review.findings.some((finding) =>
      finding.status === "open" && (finding.severity === "critical" || finding.severity === "high")
    ),
    false,
    "security review cannot pass with open critical/high findings"
  );

  const controlsByThreat = new Map(controlMap.controls.map((control) => [control.threat, control]));
  assert.equal(controlsByThreat.size, controlMap.controls.length, "security control threats must be unique");
  const knownThreats = new Set(controlsByThreat.keys());
  for (const finding of review.findings) {
    for (const threat of finding.controlThreats) {
      assert(knownThreats.has(threat), `finding ${finding.id} references unknown control ${threat}`);
    }
  }

  assertUniqueIds(review.coverage.controls.map((control) => ({ id: control.threat })), "reviewed controls");
  exactSet(
    review.coverage.controls.map((control) => control.threat),
    controlMap.controls.map((control) => control.threat),
    "reviewed security controls"
  );
  for (const reviewed of review.coverage.controls) {
    const declared = controlsByThreat.get(reviewed.threat)!;
    exactSet(reviewed.mitigations, declared.mitigations, `${reviewed.threat} mitigations`);
    exactSet(reviewed.regressionEvidence, declared.evidence, `${reviewed.threat} regression evidence`);
    assert.equal(
      reviewed.residualRisk,
      declared.residualRisk,
      `${reviewed.threat} residual risk differs from the control map`
    );
  }

  assertInventoryCoverage(
    review.coverage.trustBoundaries,
    SECURITY_REVIEW_TRUST_BOUNDARIES,
    knownThreats,
    "trust boundaries"
  );
  assertInventoryCoverage(
    review.coverage.authorityBearingTools,
    SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS,
    knownThreats,
    "authority-bearing tools"
  );

  const referencedThreats = new Set([
    ...review.coverage.trustBoundaries.flatMap((entry) => entry.controlThreats),
    ...review.coverage.authorityBearingTools.flatMap((entry) => entry.controlThreats)
  ]);
  exactSet([...referencedThreats], [...knownThreats], "controls referenced by boundary/tool coverage");

  return review;
};

export const verifySecurityReviewWorkflowEvidence = async (
  input: unknown,
  expectedBinding: SecurityReviewReleaseBinding,
  dependencies: SecurityReviewWorkflowEvidenceDependencies = {}
): Promise<SecurityReviewEvidence> => {
  const review = validateSecurityReviewEvidence(input, expectedBinding);
  const fetchJson = dependencies.fetchJson ?? defaultFetchJson;
  const workflowsByUrl = new Map<string, Promise<WorkflowRunDocument>>();

  const version = review.releaseTag.slice(1);
  const registry = object(await fetchJson(PACKAGE_REGISTRY_URL), "npm registry response") as RegistryDocument;
  const published = registry.versions?.[version];
  assert(published, `npm registry does not contain @zhivex-ai/harness@${version}`);
  assert.equal(
    published.dist?.integrity,
    review.artifactSha512,
    "security review artifact differs from npm registry integrity"
  );
  assert.equal(
    published.dist?.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    "npm registry metadata has no SLSA v1 provenance"
  );
  assert.equal(
    review.evidence.provenance.url,
    published.dist?.attestations?.url,
    "security review provenance URL differs from npm registry metadata"
  );
  const attestationDocument = object(
    await fetchJson(review.evidence.provenance.url),
    "npm attestation response"
  ) as AttestationDocument;
  const provenance = attestationDocument.attestations?.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1"
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  assert(payload, "security review SLSA provenance envelope is missing");
  const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as ProvenanceStatement;
  const integrityBytes = Buffer.from(review.artifactSha512.slice("sha512-".length), "base64");
  assertReleaseProvenance({
    statement,
    version,
    sha512Hex: integrityBytes.toString("hex"),
    releaseCommit: review.sourceCommit
  });
  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId;
  assert(
    invocationId === review.evidence.release.workflowUrl ||
      invocationId?.startsWith(`${review.evidence.release.workflowUrl}/attempts/`),
    "security review provenance invocation differs from its release workflow"
  );

  const workflowFor = (workflowUrl: string) => {
    const cached = workflowsByUrl.get(workflowUrl);
    if (cached) return cached;

    const runId = workflowUrl.slice(workflowUrl.lastIndexOf("/") + 1);
    const pending = Promise.resolve(fetchJson(
      `https://api.github.com/repos/Zhivex/zhivex-harness/actions/runs/${runId}`
    )).then((workflow) => object(workflow, "GitHub workflow response") as WorkflowRunDocument);
    workflowsByUrl.set(workflowUrl, pending);
    return pending;
  };

  for (const [evidenceClass, expectedPath, expectedEvent] of workflowExpectations) {
    const evidence = review.evidence[evidenceClass];
    const workflow = await workflowFor(evidence.workflowUrl);
    assert.equal(
      workflow.html_url,
      evidence.workflowUrl,
      `${evidenceClass} workflow URL differs from GitHub`
    );
    assert.equal(
      workflow.head_sha,
      review.sourceCommit,
      `${evidenceClass} workflow commit differs from the security review`
    );
    assert.equal(workflow.status, "completed", `${evidenceClass} workflow has not completed`);
    assert.equal(workflow.conclusion, "success", `${evidenceClass} workflow did not succeed`);
    assert.equal(workflow.path, expectedPath, `${evidenceClass} evidence used an unexpected workflow`);
    assert.equal(workflow.event, expectedEvent, `${evidenceClass} workflow used an unexpected event`);
  }

  return review;
};
