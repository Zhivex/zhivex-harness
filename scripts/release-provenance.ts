import assert from "node:assert/strict";

export interface ProvenanceStatement {
  subject?: Array<{ name?: string; digest?: { sha512?: string } }>;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: { repository?: string; path?: string; ref?: string };
      };
      resolvedDependencies?: Array<{
        uri?: string;
        digest?: { gitCommit?: string };
      }>;
    };
    runDetails?: {
      builder?: { id?: string };
      metadata?: { invocationId?: string };
    };
  };
}

interface ReleaseProvenanceExpectation {
  statement: ProvenanceStatement;
  version: string;
  sha512Hex: string;
  releaseCommit: string;
}

const repository = "https://github.com/Zhivex/zhivex-harness";
const workflowPath = ".github/workflows/release.yml";

export const acceptedReleaseWorkflowRefs = (version: string): readonly string[] => [
  "refs/heads/main",
  `refs/tags/v${version}`
];

export const assertReleaseProvenance = ({
  statement,
  version,
  sha512Hex,
  releaseCommit
}: ReleaseProvenanceExpectation): string => {
  const subject = statement.subject?.find((candidate) => candidate.digest?.sha512 === sha512Hex);
  assert(subject, "provenance subject does not bind the published SHA-512 digest");

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  assert.equal(workflow?.repository, repository, "provenance repository differs from the release repository");
  assert.equal(workflow?.path, workflowPath, "provenance workflow path differs from the release workflow");

  const acceptedRefs = acceptedReleaseWorkflowRefs(version);
  assert(
    workflow?.ref !== undefined && acceptedRefs.includes(workflow.ref),
    `provenance workflow ref must be ${acceptedRefs.join(" or ")}, received ${workflow?.ref ?? "missing"}`
  );

  const resolvedCommit = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (dependency) => dependency.digest?.gitCommit === releaseCommit
  )?.digest?.gitCommit;
  assert.equal(resolvedCommit, releaseCommit, "provenance source commit differs from the annotated release tag");
  assert.equal(
    statement.predicate?.runDetails?.builder?.id,
    "https://github.com/actions/runner/github-hosted",
    "provenance builder is not a GitHub-hosted runner"
  );
  assert(
    statement.predicate?.runDetails?.metadata?.invocationId?.startsWith(
      `${repository}/actions/runs/`
    ),
    "provenance invocation does not point to the Zhivex release workflow"
  );

  return workflow.ref;
};
