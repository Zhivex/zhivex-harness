import { z } from "zod";

const liveEvidenceSchema = z.enum([
  "passed-local-tag-source",
  "pending-release-bound-run"
]);

export const releaseStatusSchema = z.object({
  schemaVersion: z.literal(1),
  package: z.literal("@zhivex-ai/harness"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(["candidate", "published"]),
  channel: z.enum(["latest", "next"]),
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  registry: z.literal("https://registry.npmjs.org/"),
  registryIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  provenance: z.enum(["pending", "verified"]),
  githubRelease: z.url(),
  publishedAt: z.iso.datetime(),
  liveCertification: z.object({
    status: z.enum(["pending", "partial", "certified"]),
    base: liveEvidenceSchema,
    orchestration: liveEvidenceSchema,
    routing: liveEvidenceSchema,
    execution: liveEvidenceSchema,
    remoteWorkflow: z.enum([
      "blocked-missing-environment-secrets",
      "pending",
      "passed"
    ]),
    remoteWorkflowRun: z.url(),
    observedAt: z.iso.datetime()
  }).strict()
}).strict().superRefine((status, context) => {
  if (status.tag !== `v${status.version}`) {
    context.addIssue({
      code: "custom",
      path: ["tag"],
      message: "release tag must match the recorded version"
    });
  }
  if (status.status === "published" && status.provenance !== "verified") {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "a published release must have verified provenance"
    });
  }
});

export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const parseReleaseStatus = (input: unknown): ReleaseStatus => releaseStatusSchema.parse(input);
