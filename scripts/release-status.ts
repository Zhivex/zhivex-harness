import { z } from "zod";

import { assertHarnessReleaseChannel, parseHarnessReleaseVersion } from "./release-policy.js";

const liveEvidenceSchema = z.enum([
  "pending",
  "passed-local-tag-source",
  "pending-release-bound-run",
  "passed-release-bound-run"
]);

const releaseStatusBaseShape = {
  schemaVersion: z.literal(1),
  package: z.literal("@zhivex-ai/harness"),
  version: z.string(),
  channel: z.enum(["latest", "next"]),
  tag: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  registry: z.literal("https://registry.npmjs.org/")
} as const;

const liveCertificationBaseShape = {
  status: z.enum(["pending", "partial", "certified"]),
  base: liveEvidenceSchema,
  orchestration: liveEvidenceSchema,
  routing: liveEvidenceSchema,
  execution: liveEvidenceSchema,
  remoteWorkflow: z.enum([
    "blocked-missing-environment-secrets",
    "pending",
    "passed"
  ])
} as const;

const candidateReleaseStatusSchema = z.object({
  ...releaseStatusBaseShape,
  status: z.literal("candidate"),
  provenance: z.literal("pending"),
  liveCertification: z.object({
    ...liveCertificationBaseShape,
    remoteWorkflowRun: z.url().optional(),
    observedAt: z.iso.datetime().optional()
  }).strict()
}).strict();

const publishedReleaseStatusSchema = z.object({
  ...releaseStatusBaseShape,
  status: z.literal("published"),
  registryIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  provenance: z.literal("verified"),
  githubRelease: z.url(),
  publishedAt: z.iso.datetime(),
  liveCertification: z.object({
    ...liveCertificationBaseShape,
    remoteWorkflowRun: z.url(),
    observedAt: z.iso.datetime()
  }).strict()
}).strict();

export const releaseStatusSchema = z.discriminatedUnion("status", [
  candidateReleaseStatusSchema,
  publishedReleaseStatusSchema
]).superRefine((status, context) => {
  let release: ReturnType<typeof parseHarnessReleaseVersion> | undefined;
  try {
    release = assertHarnessReleaseChannel(status.version, status.channel);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["version"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
  if (status.tag !== (release?.tag ?? `v${status.version}`)) {
    context.addIssue({
      code: "custom",
      path: ["tag"],
      message: "release tag must match the recorded version"
    });
  }
  if (status.liveCertification.status === "certified") {
    for (const phase of ["base", "orchestration", "routing", "execution"] as const) {
      if (status.liveCertification[phase] !== "passed-release-bound-run") {
        context.addIssue({
          code: "custom",
          path: ["liveCertification", phase],
          message: "certified releases require release-bound evidence for every live phase"
        });
      }
    }
    if (status.liveCertification.remoteWorkflow !== "passed") {
      context.addIssue({
        code: "custom",
        path: ["liveCertification", "remoteWorkflow"],
        message: "certified releases require a successful remote workflow"
      });
    }
  }
});

export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const parseReleaseStatus = (input: unknown): ReleaseStatus => releaseStatusSchema.parse(input);
