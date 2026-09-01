import assert from "node:assert/strict";

import {
  assertReleaseProvenance,
  type ProvenanceStatement
} from "./release-provenance.js";
import { assertHarnessReleaseChannel } from "./release-policy.js";
import {
  REPRESENTATIVE_EVIDENCE_PROVIDERS,
  REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
  REPRESENTATIVE_EVIDENCE_SCENARIOS,
  validateRepresentativeEvidence,
  type RepresentativeProviderResult
} from "./representative-evidence.js";

const PACKAGE_REGISTRY_URL = "https://registry.npmjs.org/%40zhivex-ai%2Fharness";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const GITHUB_ACTIONS_RUN_PATTERN = /^https:\/\/github\.com\/Zhivex\/zhivex-harness\/actions\/runs\/[1-9]\d*$/;

export const GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE = [
  "releaseTag",
  "sourceCommit",
  "artifactSha512",
  "provider",
  "model",
  "datasetRevision",
  "driverCommit",
  "ociImageDigest",
  "workflowRunUrl",
  "observedAt",
  "cases",
  "totalRuns",
  "passedRuns",
  "failedRuns",
  "omittedRuns"
] as const;

export const GA_REPRESENTATIVE_EVALUATION_PROVIDERS = REPRESENTATIVE_EVIDENCE_PROVIDERS;

export const GA_REPRESENTATIVE_EVALUATION_SCENARIOS = REPRESENTATIVE_EVIDENCE_SCENARIOS;

export interface GaReleaseCandidateEvidence {
  version: string;
  status: "passed";
  channel: "next";
  tag: string;
  contractBreakingDefects: 0;
  publishedAt: string;
  sourceCommit: string;
  artifactSha512: string;
  workflowUrl: string;
  provenance: "verified";
  liveCertification: "passed-release-bound-run";
}

export interface GaFailedReleaseCandidateEvidence {
  version: string;
  status: "failed-gates";
  channel: "next";
  tag: string;
  contractBreakingDefects: null;
  publishedAt: null;
  sourceCommit: string;
  artifactSha512: string | null;
  workflowUrl: string;
  provenance: "not-published";
  liveCertification: "passed-release-bound-run" | "failed-release-bound-run" | "not-run";
  observedAt: string;
  failedGates: string[];
}

export interface GaPendingReleaseCandidateEvidence {
  version: string;
  status: "pending";
  channel: null;
  tag: null;
  contractBreakingDefects: null;
  publishedAt: null;
  sourceCommit: null;
  artifactSha512: null;
  workflowUrl: null;
  provenance: null;
  liveCertification: null;
}

export type GaReleaseCandidateRecord =
  | GaReleaseCandidateEvidence
  | GaFailedReleaseCandidateEvidence
  | GaPendingReleaseCandidateEvidence;

export type GaRepresentativeEvaluationResult = RepresentativeProviderResult;

interface RegistryDocument {
  time?: Record<string, string>;
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

interface WorkflowRunDocument {
  html_url?: string;
  head_sha?: string;
  event?: string;
  status?: string;
  conclusion?: string;
  path?: string;
}

export interface GaReleaseEvidenceDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
  runGit?: (arguments_: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const object = (input: unknown): Record<string, unknown> => {
  assert(input && typeof input === "object" && !Array.isArray(input), "release candidate evidence must be an object");
  return input as Record<string, unknown>;
};

export const parseGaReleaseCandidateEvidence = (input: unknown): GaReleaseCandidateEvidence => {
  const candidate = object(input);
  assert.equal(typeof candidate.version, "string", "release candidate version is required");
  const release = assertHarnessReleaseChannel(candidate.version, String(candidate.channel));
  assert(release.prerelease, `${candidate.version} must be a release candidate`);
  assert.equal(candidate.status, "passed", `${candidate.version} status must be passed`);
  assert.equal(candidate.tag, release.tag, `${candidate.version} tag must be ${release.tag}`);
  assert.equal(candidate.contractBreakingDefects, 0, `${candidate.version} must have zero contract-breaking defects`);
  assert.equal(typeof candidate.publishedAt, "string", `${candidate.version} publishedAt is required`);
  assert.match(String(candidate.sourceCommit), /^[a-f0-9]{40}$/, `${candidate.version} sourceCommit is invalid`);
  assert.match(
    String(candidate.artifactSha512),
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    `${candidate.version} artifactSha512 is invalid`
  );
  assert.match(
    String(candidate.workflowUrl),
    GITHUB_ACTIONS_RUN_PATTERN,
    `${candidate.version} workflowUrl is invalid`
  );
  assert.equal(candidate.provenance, "verified", `${candidate.version} provenance must be verified`);
  assert.equal(
    candidate.liveCertification,
    "passed-release-bound-run",
    `${candidate.version} live certification must be release-bound`
  );
  return candidate as unknown as GaReleaseCandidateEvidence;
};

export const parseGaFailedReleaseCandidateEvidence = (input: unknown): GaFailedReleaseCandidateEvidence => {
  const candidate = object(input);
  assert.equal(typeof candidate.version, "string", "failed release candidate version is required");
  const release = assertHarnessReleaseChannel(candidate.version, String(candidate.channel));
  assert(release.prerelease, `${candidate.version} must be a release candidate`);
  assert.equal(candidate.status, "failed-gates", `${candidate.version} status must be failed-gates`);
  assert.equal(candidate.tag, release.tag, `${candidate.version} tag must be ${release.tag}`);
  assert.equal(
    candidate.contractBreakingDefects,
    null,
    `${candidate.version} cannot claim a contract-defect count after failed gates`
  );
  assert.equal(candidate.publishedAt, null, `${candidate.version} failed attempt must not claim publication`);
  assert.match(String(candidate.sourceCommit), /^[a-f0-9]{40}$/, `${candidate.version} sourceCommit is invalid`);
  assert.match(String(candidate.workflowUrl), GITHUB_ACTIONS_RUN_PATTERN, `${candidate.version} workflowUrl is invalid`);
  assert.equal(candidate.provenance, "not-published", `${candidate.version} provenance must record non-publication`);
  assert.equal(typeof candidate.observedAt, "string", `${candidate.version} observedAt is required`);
  assert(!Number.isNaN(Date.parse(String(candidate.observedAt))), `${candidate.version} observedAt is invalid`);
  assert(Array.isArray(candidate.failedGates) && candidate.failedGates.length > 0,
    `${candidate.version} failedGates must identify at least one gate`);
  const failedGates = candidate.failedGates as unknown[];
  assert(failedGates.every((gate) => typeof gate === "string" && /^[a-z][a-z0-9-]*$/.test(gate)),
    `${candidate.version} failedGates must use stable kebab-case identifiers`);
  assert.equal(new Set(failedGates).size, failedGates.length, `${candidate.version} failedGates must be unique`);
  const preArtifactFailure = failedGates.includes("deterministic-validation");
  if (failedGates.includes("artifact-binding")) {
    assert.deepEqual(
      failedGates,
      ["artifact-binding"],
      `${candidate.version} artifact-binding failure must not claim outcomes for gates that did not run`
    );
  }
  if (preArtifactFailure) {
    assert.deepEqual(
      failedGates,
      ["deterministic-validation"],
      `${candidate.version} deterministic-validation failure must not claim outcomes for gates that did not run`
    );
    assert.equal(
      candidate.artifactSha512,
      null,
      `${candidate.version} deterministic-validation failure must not claim an artifact digest`
    );
  } else {
    assert.match(
      String(candidate.artifactSha512),
      /^sha512-[A-Za-z0-9+/]+={0,2}$/,
      `${candidate.version} artifactSha512 is invalid`
    );
  }
  const expectedLiveCertification = failedGates.includes("artifact-binding") || preArtifactFailure
    ? "not-run"
    : failedGates.includes("live-provider-certification")
      ? "failed-release-bound-run"
      : "passed-release-bound-run";
  assert.equal(
    candidate.liveCertification,
    expectedLiveCertification,
    `${candidate.version} live certification must agree with failedGates`
  );
  return candidate as unknown as GaFailedReleaseCandidateEvidence;
};

export const parseGaPendingReleaseCandidateEvidence = (input: unknown): GaPendingReleaseCandidateEvidence => {
  const candidate = object(input);
  assert.equal(typeof candidate.version, "string", "pending release candidate version is required");
  const release = assertHarnessReleaseChannel(candidate.version, "next");
  assert(release.prerelease, `${candidate.version} must be a release candidate`);
  assert.equal(candidate.status, "pending", `${candidate.version} status must be pending`);
  for (const field of [
    "channel",
    "tag",
    "contractBreakingDefects",
    "publishedAt",
    "sourceCommit",
    "artifactSha512",
    "workflowUrl",
    "provenance",
    "liveCertification"
  ] as const) {
    assert.equal(candidate[field], null, `${candidate.version} pending ${field} must be null`);
  }
  return candidate as unknown as GaPendingReleaseCandidateEvidence;
};

export const parseGaReleaseCandidateRecord = (input: unknown): GaReleaseCandidateRecord => {
  const candidate = object(input);
  if (candidate.status === "passed") return parseGaReleaseCandidateEvidence(candidate);
  if (candidate.status === "failed-gates") return parseGaFailedReleaseCandidateEvidence(candidate);
  if (candidate.status === "pending") return parseGaPendingReleaseCandidateEvidence(candidate);
  throw new assert.AssertionError({
    message: `${String(candidate.version)} release candidate status must be pending, failed-gates, or passed`
  });
};

export const parseGaSecurityReviewEvidencePath = (input: unknown): string => {
  assert.equal(typeof input, "string", "security review evidence must be a workspace-relative path");
  assert.match(
    input,
    /^security-reviews\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
    "security review evidence must be a JSON file under security-reviews/"
  );
  return input;
};

export const parseGaRepresentativeEvaluationCoverage = (
  candidates: readonly GaReleaseCandidateEvidence[],
  input: unknown,
  requiredEvidence: unknown,
  declaredScenarios: unknown,
  expectedCases: unknown,
  expectedModels: unknown
): GaRepresentativeEvaluationResult[] => {
  assert.deepEqual(
    requiredEvidence,
    GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE,
    "representative evaluation requiredEvidence contract drifted"
  );
  assert.deepEqual(
    declaredScenarios,
    GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
    "representative evaluation scenarios contract drifted"
  );
  const releaseTags = candidates.map((candidate) => candidate.tag);
  const candidateModelPins = Array.isArray(expectedModels)
    ? expectedModels.filter((entry) =>
        entry && typeof entry === "object" &&
        releaseTags.includes(String((entry as Record<string, unknown>).releaseTag))
      )
    : expectedModels;
  const evidence = validateRepresentativeEvidence({
    schemaVersion: REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
    kind: "harness-representative-evaluation-evidence",
    releaseTags,
    expectedModels: candidateModelPins,
    expectedCases,
    results: input
  }, releaseTags);
  for (const result of evidence.results) {
    const candidate = candidates.find((entry) => entry.tag === result.releaseTag)!;
    assert.equal(
      result.sourceCommit,
      candidate.sourceCommit,
      `${result.releaseTag}/${result.provider} sourceCommit differs from its release candidate`
    );
    assert.equal(
      result.artifactSha512,
      candidate.artifactSha512,
      `${result.releaseTag}/${result.provider} artifactSha512 differs from its release candidate`
    );
    assert.equal(
      result.workflowRunUrl,
      candidate.workflowUrl,
      `${result.releaseTag}/${result.provider} workflow differs from its release candidate`
    );
  }
  return evidence.results;
};

export const assertDistinctGaReleaseCandidateEvidence = (
  candidates: readonly GaReleaseCandidateEvidence[]
) => {
  for (const field of ["version", "tag", "sourceCommit", "artifactSha512", "workflowUrl"] as const) {
    assert.equal(
      new Set(candidates.map((candidate) => candidate[field])).size,
      candidates.length,
      `release candidates must have distinct ${field} values`
    );
  }
};

export const assertGaReleaseCandidateSequence = (versions: readonly unknown[]) => {
  assert(
    versions.length >= 2,
    "readiness must record at least rc.1 and rc.2"
  );
  for (const [index, version] of versions.entries()) {
    assert.equal(
      version,
      `1.0.0-rc.${index + 1}`,
      "readiness release candidates must be a contiguous sequence starting at 1.0.0-rc.1"
    );
  }
};

export const assertAtLeastTwoPassingGaReleaseCandidates = (
  candidates: readonly GaReleaseCandidateEvidence[]
) => {
  assert(candidates.length >= 2, "GA requires at least two passing release candidates");
};

const defaultRunGit = async (arguments_: readonly string[]) => {
  const child = Bun.spawn(["git", ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      ...(githubToken && url.startsWith("https://api.github.com/")
        ? { authorization: `Bearer ${githubToken}` }
        : {})
    },
    signal: AbortSignal.timeout(20_000)
  });
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return await response.json();
};

export const verifyGaRepresentativeEvaluationWorkflows = async (
  candidates: readonly GaReleaseCandidateEvidence[],
  results: readonly GaRepresentativeEvaluationResult[],
  dependencies: Pick<GaReleaseEvidenceDependencies, "fetchJson"> = {}
) => {
  const fetchJson = dependencies.fetchJson ?? defaultFetchJson;
  for (const candidate of candidates) {
    const workflowUrls = new Set(
      results
        .filter((result) => result.releaseTag === candidate.tag)
        .map((result) => result.workflowRunUrl)
    );
    assert.equal(workflowUrls.size, 1, `${candidate.tag} must have one representative evaluation workflow`);
    const workflowUrl = [...workflowUrls][0]!;
    const runId = workflowUrl.slice(workflowUrl.lastIndexOf("/") + 1);
    const workflow = object(await fetchJson(
      `https://api.github.com/repos/Zhivex/zhivex-harness/actions/runs/${runId}`
    )) as WorkflowRunDocument;
    assert.equal(workflow.html_url, workflowUrl, `${candidate.tag} evaluation workflow URL differs from GitHub`);
    assert.equal(
      workflow.head_sha,
      candidate.sourceCommit,
      `${candidate.tag} evaluation workflow commit differs from its release candidate`
    );
    assert.equal(workflow.event, "workflow_dispatch", `${candidate.tag} evaluation was not manually dispatched`);
    assert.equal(workflow.status, "completed", `${candidate.tag} evaluation workflow has not completed`);
    assert.equal(workflow.conclusion, "success", `${candidate.tag} evaluation workflow did not succeed`);
    assert.equal(
      workflow.path,
      RELEASE_WORKFLOW_PATH,
      `${candidate.tag} evaluation evidence used an unexpected workflow`
    );
  }
};

export const verifyPublishedGaReleaseCandidate = async (
  candidate: GaReleaseCandidateEvidence,
  dependencies: GaReleaseEvidenceDependencies = {}
) => {
  const runGit = dependencies.runGit ?? defaultRunGit;
  const fetchJson = dependencies.fetchJson ?? defaultFetchJson;

  const tagType = await runGit(["cat-file", "-t", candidate.tag]);
  assert.equal(tagType.exitCode, 0, `${candidate.tag} does not exist in the checkout`);
  assert.equal(tagType.stdout, "tag", `${candidate.tag} must be annotated`);
  const tagCommit = await runGit(["rev-list", "-n", "1", candidate.tag]);
  assert.equal(tagCommit.exitCode, 0, `${candidate.tag} commit cannot be resolved`);
  assert.equal(tagCommit.stdout, candidate.sourceCommit, `${candidate.tag} does not resolve to its recorded commit`);
  const mainAncestor = await runGit([
    "merge-base",
    "--is-ancestor",
    candidate.sourceCommit,
    "origin/main"
  ]);
  assert.equal(mainAncestor.exitCode, 0, `${candidate.tag} is not reachable from origin/main`);

  const registry = object(await fetchJson(PACKAGE_REGISTRY_URL)) as RegistryDocument;
  const published = registry.versions?.[candidate.version];
  assert(published, `registry does not contain @zhivex-ai/harness@${candidate.version}`);
  assert.equal(
    registry.time?.[candidate.version],
    candidate.publishedAt,
    `${candidate.version} registry publication time differs from the recorded evidence`
  );
  assert.equal(
    published.dist?.integrity,
    candidate.artifactSha512,
    `${candidate.version} registry integrity differs from the recorded artifact`
  );
  assert.equal(
    published.dist?.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    `${candidate.version} registry metadata has no SLSA v1 provenance`
  );
  const attestationUrl = published.dist?.attestations?.url;
  assert(attestationUrl, `${candidate.version} registry metadata has no attestation URL`);
  const attestations = object(await fetchJson(attestationUrl)) as AttestationDocument;
  const provenance = attestations.attestations?.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1"
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  assert(payload, `${candidate.version} SLSA provenance envelope is missing`);
  const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as ProvenanceStatement;
  const integrityBytes = Buffer.from(candidate.artifactSha512.slice("sha512-".length), "base64");
  assert.equal(integrityBytes.length, 64, `${candidate.version} artifactSha512 must decode to 64 bytes`);
  assertReleaseProvenance({
    statement,
    version: candidate.version,
    sha512Hex: integrityBytes.toString("hex"),
    releaseCommit: candidate.sourceCommit
  });
  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId;
  assert(
    invocationId === candidate.workflowUrl || invocationId?.startsWith(`${candidate.workflowUrl}/attempts/`),
    `${candidate.version} provenance invocation differs from its recorded workflow`
  );

  const runId = candidate.workflowUrl.slice(candidate.workflowUrl.lastIndexOf("/") + 1);
  const workflow = object(await fetchJson(
    `https://api.github.com/repos/Zhivex/zhivex-harness/actions/runs/${runId}`
  )) as WorkflowRunDocument;
  assert.equal(workflow.html_url, candidate.workflowUrl, `${candidate.version} workflow URL differs from GitHub`);
  assert.equal(workflow.head_sha, candidate.sourceCommit, `${candidate.version} workflow commit differs from its tag`);
  assert.equal(workflow.event, "workflow_dispatch", `${candidate.version} was not released by workflow dispatch`);
  assert.equal(workflow.status, "completed", `${candidate.version} workflow has not completed`);
  assert.equal(workflow.conclusion, "success", `${candidate.version} workflow did not succeed`);
  assert.equal(workflow.path, RELEASE_WORKFLOW_PATH, `${candidate.version} used an unexpected workflow`);
};
