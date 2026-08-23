import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

export const EDIT_CONTRACT_SCHEMA_VERSION = 1 as const;
export const EDIT_DIGEST_ALGORITHM = "sha256" as const;
export const MAX_EDIT_CHANGES = 50;
export const MAX_EDIT_FILE_BYTES = 1024 * 1024;
export const MAX_EDIT_PROPOSAL_BYTES = 4 * 1024 * 1024;

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const fileDigestSchema = z.string().regex(
  SHA256_DIGEST_PATTERN,
  "Digest must use the format sha256:<64 lowercase hexadecimal characters>."
);

export type FileDigest = z.infer<typeof fileDigestSchema>;

const expectedEditDigestSchema = fileDigestSchema.nullable().describe(
  "Required. Use the inspected sha256 digest for an existing file, or explicit JSON null for a create-only target. Never omit this field."
);

export const workspaceFilePathSchema = z.string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes("\0"), "Path cannot contain a NUL byte.")
  .refine((value) => !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value), "Path must be relative.")
  .refine((value) => {
    const segments = value.split(/[\\/]+/);
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }, "Path must be normalized and cannot contain empty, dot, or parent segments.");

export const editChangeSchema = z.strictObject({
  path: workspaceFilePathSchema,
  expectedDigest: expectedEditDigestSchema,
  content: z.string()
}).superRefine((change, context) => {
  if (Buffer.byteLength(change.content, "utf8") > MAX_EDIT_FILE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: `Content exceeds the ${MAX_EDIT_FILE_BYTES}-byte per-file limit.`
    });
  }
});

export type EditChange = z.infer<typeof editChangeSchema>;

export const editChangesSchema = z.array(editChangeSchema)
  .min(1)
  .max(MAX_EDIT_CHANGES)
  .superRefine((changes, context) => {
    const paths = new Set<string>();
    let totalBytes = 0;
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (!change) {
        continue;
      }
      if (paths.has(change.path)) {
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: `Duplicate target path: ${change.path}.`
        });
      }
      paths.add(change.path);
      totalBytes += Buffer.byteLength(change.content, "utf8");
    }
    if (totalBytes > MAX_EDIT_PROPOSAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Proposal exceeds the ${MAX_EDIT_PROPOSAL_BYTES}-byte aggregate limit.`
      });
    }
  });

export const editProposalInputSchema = z.strictObject({
  changes: editChangesSchema
});

export const editProposalChangeSchema = z.strictObject({
  path: workspaceFilePathSchema,
  expectedDigest: expectedEditDigestSchema,
  contentDigest: fileDigestSchema,
  bytes: z.number().int().min(0).max(MAX_EDIT_FILE_BYTES)
});

export type EditProposalChange = z.infer<typeof editProposalChangeSchema>;

export const editProposalSchema = z.strictObject({
  schemaVersion: z.literal(EDIT_CONTRACT_SCHEMA_VERSION),
  kind: z.literal("edit-proposal"),
  proposalId: fileDigestSchema,
  digestAlgorithm: z.literal(EDIT_DIGEST_ALGORITHM),
  changes: z.array(editProposalChangeSchema).min(1).max(MAX_EDIT_CHANGES)
});

export type EditProposal = z.infer<typeof editProposalSchema>;

export interface ApplyEditProposalInput {
  proposalId: FileDigest;
  changes: EditChange[];
}

export const applyEditProposalInputSchema = z.strictObject({
  proposalId: fileDigestSchema,
  changes: editChangesSchema
});

export const moveFileInputSchema = z.strictObject({
  source: workspaceFilePathSchema,
  destination: workspaceFilePathSchema,
  expectedDigest: fileDigestSchema
}).refine((input) => input.source !== input.destination, {
  path: ["destination"],
  message: "Move destination must differ from source."
});

export type MoveFileInput = z.infer<typeof moveFileInputSchema>;

export const quarantineFileInputSchema = z.strictObject({
  path: workspaceFilePathSchema,
  expectedDigest: fileDigestSchema
});

export type QuarantineFileInput = z.infer<typeof quarantineFileInputSchema>;

export const restoreFileInputSchema = z.strictObject({
  quarantineId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  destination: workspaceFilePathSchema.optional(),
  expectedDigest: fileDigestSchema.optional()
});

export type RestoreFileInput = z.infer<typeof restoreFileInputSchema>;

export const mutationOperationSchema = z.enum(["create", "update", "move", "quarantine", "restore"]);

export type MutationOperation = z.infer<typeof mutationOperationSchema>;

export const mutationAuditEntrySchema = z.strictObject({
  id: z.string().min(1).max(200),
  operation: mutationOperationSchema,
  path: workspaceFilePathSchema,
  destination: workspaceFilePathSchema.optional(),
  beforeDigest: fileDigestSchema.optional(),
  afterDigest: fileDigestSchema.optional(),
  timestamp: z.iso.datetime(),
  quarantineId: z.string().min(1).max(200).optional()
});

export type MutationAuditEntry = z.infer<typeof mutationAuditEntrySchema>;

export interface ApplyPatchResult {
  proposalId: FileDigest;
  changes: MutationAuditEntry[];
}

export interface MoveFileResult {
  source: string;
  destination: string;
  digest: FileDigest;
  audit: MutationAuditEntry;
}

export interface QuarantineFileResult {
  quarantineId: string;
  path: string;
  digest: FileDigest;
  audit: MutationAuditEntry;
}

export interface RestoreFileResult {
  quarantineId: string;
  path: string;
  digest: FileDigest;
  audit: MutationAuditEntry;
}

const digest = (value: string | Uint8Array): FileDigest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const canonicalProposalPayload = (changes: readonly EditChange[]) => ({
  schemaVersion: EDIT_CONTRACT_SCHEMA_VERSION,
  kind: "edit-proposal" as const,
  digestAlgorithm: EDIT_DIGEST_ALGORITHM,
  changes: [...changes]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((change) => ({
      path: change.path,
      expectedDigest: change.expectedDigest,
      contentDigest: digest(change.content),
      bytes: Buffer.byteLength(change.content, "utf8")
    }))
});

export const createEditProposal = (input: unknown): EditProposal => {
  const parsed = editProposalInputSchema.parse(input);
  const payload = canonicalProposalPayload(parsed.changes);
  return editProposalSchema.parse({
    ...payload,
    proposalId: digest(JSON.stringify(payload))
  });
};

export const validateEditProposal = (input: unknown): ApplyEditProposalInput => {
  const parsed = applyEditProposalInputSchema.parse(input);
  const proposal = createEditProposal({ changes: parsed.changes });
  if (proposal.proposalId !== parsed.proposalId) {
    throw new Error("proposalId does not match the supplied paths, preconditions, and content.");
  }
  return parsed;
};

export interface EditContractDocument<TKind extends string, TResult> {
  schemaVersion: typeof EDIT_CONTRACT_SCHEMA_VERSION;
  kind: TKind;
  result: TResult;
}

export const editContractDocument = <TKind extends string, TResult>(
  kind: TKind,
  result: TResult
): EditContractDocument<TKind, TResult> => ({
  schemaVersion: EDIT_CONTRACT_SCHEMA_VERSION,
  kind,
  result
});
