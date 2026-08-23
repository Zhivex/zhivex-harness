import assert from "node:assert/strict";

import {
  assertReleaseProvenance,
  type ProvenanceStatement
} from "./release-provenance.js";
import { assertHarnessReleaseChannel } from "./release-policy.js";

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
  "workflowUrl",
  "observedAt",
  "scenarios",
  "totalRuns",
  "failedRuns",
  "omittedRuns"
] as const;

export const GA_REPRESENTATIVE_EVALUATION_PROVIDERS = ["meta", "qwen", "openai"] as const;

export const GA_REPRESENTATIVE_EVALUATION_SCENARIOS = [
  "typescript-node-package",
  "json-cli-contract",
  "sqlite-restart-and-resume",
  "target-package-managers",
  "python-pytest-repository",
  "hostile-instructions",
  "concurrent-change-conflict"
] as const;

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

export interface GaRepresentativeEvaluationResult extends Record<string, unknown> {
  releaseTag: string;
  sourceCommit: string;
  artifactSha512: string;
  provider: (typeof GA_REPRESENTATIVE_EVALUATION_PROVIDERS)[number];
  model: string;
  datasetRevision: string;
  driverCommit: string;
  ociImageDigest: string;
  workflowUrl: string;
  observedAt: string;
  scenarios: readonly string[];
  totalRuns: number;
  failedRuns: 0;
  omittedRuns: 0;
}

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

export const parseGaSecurityReviewEvidencePath = (input: unknown): string => {
  assert.equal(typeof input, "string", "security review evidence must be a workspace-relative path");
  assert.match(
    input,
    /^security-reviews\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|md)$/,
    "security review evidence must be a file under security-reviews/"
  );
  return input;
};

export const parseGaRepresentativeEvaluationCoverage = (
  candidates: readonly GaReleaseCandidateEvidence[],
  input: unknown,
  requiredEvidence: unknown,
  declaredScenarios: unknown
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
  assert(Array.isArray(input), "representative evaluation results must be an array");
  const results = input.map((entry) => object(entry));
  const expectedRows = candidates.length * GA_REPRESENTATIVE_EVALUATION_PROVIDERS.length;
  assert.equal(
    results.length,
    expectedRows,
    `representative evaluation must contain exactly ${expectedRows} candidate/provider results`
  );

  const parsed: GaRepresentativeEvaluationResult[] = [];
  const workflowCandidate = new Map<string, string>();
  for (const candidate of candidates) {
    const candidateWorkflows = new Set<string>();
    for (const provider of GA_REPRESENTATIVE_EVALUATION_PROVIDERS) {
      const matches = results.filter(
        (result) => result.releaseTag === candidate.tag && result.provider === provider
      );
      assert.equal(
        matches.length,
        1,
        `representative evaluation requires exactly one ${provider} result for ${candidate.tag}`
      );
      const result = matches[0]!;
      for (const field of GA_REPRESENTATIVE_EVALUATION_REQUIRED_EVIDENCE) {
        assert(
          result[field] !== undefined && result[field] !== null,
          `${candidate.tag}/${provider} is missing ${field}`
        );
      }
      for (const field of [
        "releaseTag",
        "sourceCommit",
        "artifactSha512",
        "provider",
        "model",
        "datasetRevision",
        "driverCommit",
        "ociImageDigest",
        "workflowUrl",
        "observedAt"
      ] as const) {
        assert(
          typeof result[field] === "string" && result[field].trim().length > 0,
          `${candidate.tag}/${provider} ${field} must be a non-empty string`
        );
      }
      assert.equal(
        result.sourceCommit,
        candidate.sourceCommit,
        `${candidate.tag}/${provider} sourceCommit differs from its release candidate`
      );
      assert.equal(
        result.artifactSha512,
        candidate.artifactSha512,
        `${candidate.tag}/${provider} artifactSha512 differs from its release candidate`
      );
      assert.match(
        String(result.driverCommit),
        /^[a-f0-9]{40}$/,
        `${candidate.tag}/${provider} driverCommit is invalid`
      );
      assert.match(
        String(result.ociImageDigest),
        /^sha256:[a-f0-9]{64}$/,
        `${candidate.tag}/${provider} ociImageDigest is invalid`
      );
      assert.match(
        String(result.workflowUrl),
        GITHUB_ACTIONS_RUN_PATTERN,
        `${candidate.tag}/${provider} workflowUrl is invalid`
      );
      assert.deepEqual(
        result.scenarios,
        GA_REPRESENTATIVE_EVALUATION_SCENARIOS,
        `${candidate.tag}/${provider} does not cover every declared scenario`
      );
      assert(
        Number.isSafeInteger(result.totalRuns) &&
          Number(result.totalRuns) >= GA_REPRESENTATIVE_EVALUATION_SCENARIOS.length,
        `${candidate.tag}/${provider} totalRuns must cover every declared scenario`
      );
      assert.equal(result.failedRuns, 0, `${candidate.tag}/${provider} contains failed runs`);
      assert.equal(result.omittedRuns, 0, `${candidate.tag}/${provider} contains omitted runs`);

      const previousCandidate = workflowCandidate.get(String(result.workflowUrl));
      assert(
        previousCandidate === undefined || previousCandidate === candidate.tag,
        `representative evaluation workflow ${String(result.workflowUrl)} is reused across release candidates`
      );
      workflowCandidate.set(String(result.workflowUrl), candidate.tag);
      candidateWorkflows.add(String(result.workflowUrl));
      parsed.push(result as GaRepresentativeEvaluationResult);
    }
    assert.equal(
      candidateWorkflows.size,
      1,
      `${candidate.tag} provider results must share one representative evaluation workflow`
    );
  }
  return parsed;
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
        .map((result) => result.workflowUrl)
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
