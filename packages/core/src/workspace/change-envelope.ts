import { createHash } from "node:crypto";

import { z } from "zod";

import { fileDigestSchema, type FileDigest } from "./edit-contracts.js";

export const CHANGE_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const CHANGE_ENVELOPE_DIGEST_ALGORITHM = "sha256" as const;
export const MAX_CHANGE_ENVELOPE_CHECKS = 100;
export const MAX_CHANGE_ENVELOPE_APPROVALS = 100;
export const MAX_CHANGE_ENVELOPE_APPROVAL_SCOPES = 32;
export const MAX_CHANGE_ENVELOPE_ATTESTATIONS = 32;

const timestampSchema = z.iso.datetime({ precision: 3 });
const boundedIdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
    "Identifier must contain only bounded non-secret token characters."
  );
const approvalScopeSchema = z.string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/*-]*$/,
    "Approval scope must contain only bounded token characters."
  );
const attestationFormatSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);
const mediaTypeSchema = z.string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/);

const addDuplicateIssues = <T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.core.$RefinementCtx,
  path: string
) => {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    const identifier = key(value);
    if (seen.has(identifier)) {
      context.addIssue({
        code: "custom",
        path: [index, path],
        message: `Duplicate ${path}: ${identifier}.`
      });
    }
    seen.add(identifier);
  }
};

const addCanonicalOrderIssue = <T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.core.$RefinementCtx,
  path: string
) => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && key(previous) >= key(current)) {
      context.addIssue({
        code: "custom",
        path: [index, path],
        message: `${path} entries must be unique and in canonical ascending order.`
      });
    }
  }
};

const approvalScopesInputSchema = z.array(approvalScopeSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_APPROVAL_SCOPES)
  .superRefine((scopes, context) => addDuplicateIssues(scopes, (scope) => scope, context, "scope"));

const canonicalApprovalScopesSchema = z.array(approvalScopeSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_APPROVAL_SCOPES)
  .superRefine((scopes, context) => addCanonicalOrderIssue(scopes, (scope) => scope, context, "scope"));

export const changeEnvelopeCheckSchema = z.strictObject({
  checkId: boundedIdentifierSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  redacted: z.literal(true),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  exitCode: z.number().int().min(0).max(255).optional(),
  redactedOutputDigest: fileDigestSchema.optional(),
  runnerFingerprint: fileDigestSchema.optional()
}).superRefine((check, context) => {
  const startedAt = Date.parse(check.startedAt);
  const completedAt = Date.parse(check.completedAt);
  if (completedAt < startedAt) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "Check completion cannot precede its start."
    });
  }
  if (check.status === "passed" && check.exitCode !== undefined && check.exitCode !== 0) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: "A passed check cannot have a non-zero exit code."
    });
  }
  if (check.status === "failed" && check.exitCode === 0) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: "A failed check cannot have a zero exit code."
    });
  }
  if (check.status === "skipped" && check.exitCode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: "A skipped check cannot have an exit code."
    });
  }
});

export type ChangeEnvelopeCheck = z.infer<typeof changeEnvelopeCheckSchema>;

const checkInputListSchema = z.array(changeEnvelopeCheckSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_CHECKS)
  .superRefine((checks, context) => addDuplicateIssues(checks, (check) => check.checkId, context, "checkId"));

const canonicalCheckListSchema = z.array(changeEnvelopeCheckSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_CHECKS)
  .superRefine((checks, context) => addCanonicalOrderIssue(checks, (check) => check.checkId, context, "checkId"));

export const changeEnvelopeApprovalSchema = z.strictObject({
  kind: z.literal("approval-reference"),
  approvalId: boundedIdentifierSchema,
  approvalDigest: fileDigestSchema,
  approverDigest: fileDigestSchema,
  scopes: canonicalApprovalScopesSchema,
  approvedAt: timestampSchema,
  expiresAt: timestampSchema.optional()
}).superRefine((approval, context) => {
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Approval expiry must be later than approval time."
    });
  }
});

export type ChangeEnvelopeApproval = z.infer<typeof changeEnvelopeApprovalSchema>;

const changeEnvelopeApprovalInputSchema = z.strictObject({
  kind: z.literal("approval-reference"),
  approvalId: boundedIdentifierSchema,
  approvalDigest: fileDigestSchema,
  approverDigest: fileDigestSchema,
  scopes: approvalScopesInputSchema,
  approvedAt: timestampSchema,
  expiresAt: timestampSchema.optional()
}).superRefine((approval, context) => {
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Approval expiry must be later than approval time."
    });
  }
});

const approvalInputListSchema = z.array(changeEnvelopeApprovalInputSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_APPROVALS)
  .superRefine((approvals, context) => addDuplicateIssues(
    approvals,
    (approval) => approval.approvalId,
    context,
    "approvalId"
  ));

const canonicalApprovalListSchema = z.array(changeEnvelopeApprovalSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_APPROVALS)
  .superRefine((approvals, context) => addCanonicalOrderIssue(
    approvals,
    (approval) => approval.approvalId,
    context,
    "approvalId"
  ));

export const externalAttestationReferenceSchema = z.strictObject({
  kind: z.literal("external-attestation-reference"),
  attestationId: boundedIdentifierSchema,
  format: attestationFormatSchema,
  mediaType: mediaTypeSchema,
  bundleDigest: fileDigestSchema
});

export type ExternalAttestationReference = z.infer<typeof externalAttestationReferenceSchema>;

const externalAttestationInputListSchema = z.array(externalAttestationReferenceSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_ATTESTATIONS)
  .superRefine((attestations, context) => addDuplicateIssues(
    attestations,
    (attestation) => attestation.attestationId,
    context,
    "attestationId"
  ));

const canonicalExternalAttestationListSchema = z.array(externalAttestationReferenceSchema)
  .min(1)
  .max(MAX_CHANGE_ENVELOPE_ATTESTATIONS)
  .superRefine((attestations, context) => addCanonicalOrderIssue(
    attestations,
    (attestation) => attestation.attestationId,
    context,
    "attestationId"
  ));

export const changeEnvelopeBaseSchema = z.strictObject({
  workspaceDigest: fileDigestSchema,
  treeDigest: fileDigestSchema
});

export const changeEnvelopePatchSchema = z.strictObject({
  patchId: boundedIdentifierSchema,
  patchDigest: fileDigestSchema
});

export const changeEnvelopeFingerprintsSchema = z.strictObject({
  harness: fileDigestSchema,
  policy: fileDigestSchema,
  environment: fileDigestSchema
});

export const changeEnvelopeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(CHANGE_ENVELOPE_SCHEMA_VERSION),
  kind: z.literal("check-evidence-summary"),
  digestAlgorithm: z.literal(CHANGE_ENVELOPE_DIGEST_ALGORITHM),
  evidenceDigest: fileDigestSchema,
  checks: canonicalCheckListSchema
});

export type ChangeEnvelopeEvidence = z.infer<typeof changeEnvelopeEvidenceSchema>;

export const changeEnvelopeInputSchema = z.strictObject({
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  base: changeEnvelopeBaseSchema,
  patch: changeEnvelopePatchSchema,
  fingerprints: changeEnvelopeFingerprintsSchema,
  checks: checkInputListSchema,
  approvals: approvalInputListSchema.optional(),
  externalAttestations: externalAttestationInputListSchema.optional()
});

export type CreateChangeEnvelopeInput = z.infer<typeof changeEnvelopeInputSchema>;

export const changeEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(CHANGE_ENVELOPE_SCHEMA_VERSION),
  kind: z.literal("change-envelope"),
  digestAlgorithm: z.literal(CHANGE_ENVELOPE_DIGEST_ALGORITHM),
  envelopeId: fileDigestSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  base: changeEnvelopeBaseSchema,
  patch: changeEnvelopePatchSchema,
  fingerprints: changeEnvelopeFingerprintsSchema,
  evidence: changeEnvelopeEvidenceSchema,
  approvals: canonicalApprovalListSchema.optional(),
  externalAttestations: canonicalExternalAttestationListSchema.optional()
}).superRefine((envelope, context) => {
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.parse(envelope.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Envelope expiry must be later than creation time."
    });
  }
  for (let index = 0; index < envelope.evidence.checks.length; index += 1) {
    const check = envelope.evidence.checks[index];
    if (check && Date.parse(check.completedAt) > Date.parse(envelope.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "checks", index, "completedAt"],
        message: "Check completion cannot be later than envelope creation time."
      });
    }
  }
  for (let index = 0; index < (envelope.approvals?.length ?? 0); index += 1) {
    const approval = envelope.approvals?.[index];
    if (approval && Date.parse(approval.approvedAt) > Date.parse(envelope.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["approvals", index, "approvedAt"],
        message: "Approval time cannot be later than envelope creation time."
      });
    }
  }
});

export type ChangeEnvelope = z.infer<typeof changeEnvelopeSchema>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode a non-finite number.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
};

const digestCanonical = (value: unknown): FileDigest =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** Content-addresses exact artifact bytes for patch/base inputs without parsing them. */
export const digestChangeEnvelopeArtifact = (value: string | Uint8Array): FileDigest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const evidencePayload = (checks: readonly ChangeEnvelopeCheck[]) => ({
  schemaVersion: CHANGE_ENVELOPE_SCHEMA_VERSION,
  kind: "check-evidence-summary" as const,
  digestAlgorithm: CHANGE_ENVELOPE_DIGEST_ALGORITHM,
  checks: [...checks]
});

const envelopePayload = (envelope: ChangeEnvelope) => {
  const { envelopeId: _envelopeId, ...payload } = envelope;
  return payload;
};

const sortBy = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

/**
 * Creates a content-addressed envelope. The caller supplies all timestamps, so
 * repeated calls with semantically identical input return the same envelope.
 * Raw command output, prompts, reasons, and credentials are intentionally not
 * representable by this contract.
 */
export const createChangeEnvelope = (input: unknown): ChangeEnvelope => {
  const parsed = changeEnvelopeInputSchema.parse(input);
  const checks = sortBy(parsed.checks, (check) => check.checkId);
  const evidenceWithoutDigest = evidencePayload(checks);
  const evidence: ChangeEnvelopeEvidence = {
    ...evidenceWithoutDigest,
    evidenceDigest: digestCanonical(evidenceWithoutDigest)
  };
  const approvals = parsed.approvals
    ? sortBy(parsed.approvals, (approval) => approval.approvalId).map((approval) => ({
        ...approval,
        scopes: [...approval.scopes].sort()
      }))
    : undefined;
  const externalAttestations = parsed.externalAttestations
    ? sortBy(parsed.externalAttestations, (attestation) => attestation.attestationId)
    : undefined;
  const payload = {
    schemaVersion: CHANGE_ENVELOPE_SCHEMA_VERSION,
    kind: "change-envelope" as const,
    digestAlgorithm: CHANGE_ENVELOPE_DIGEST_ALGORITHM,
    createdAt: parsed.createdAt,
    ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    base: parsed.base,
    patch: parsed.patch,
    fingerprints: parsed.fingerprints,
    evidence,
    ...(approvals ? { approvals } : {}),
    ...(externalAttestations ? { externalAttestations } : {})
  };
  return changeEnvelopeSchema.parse({
    ...payload,
    envelopeId: digestCanonical(payload)
  });
};

/** Returns the canonical, whitespace-free JSON representation of a valid envelope. */
export const canonicalizeChangeEnvelope = (input: unknown): string =>
  canonicalJson(changeEnvelopeSchema.parse(input));

/** Recomputes the envelope identifier without trusting its embedded envelopeId. */
export const computeChangeEnvelopeDigest = (input: unknown): FileDigest => {
  const parsed = changeEnvelopeSchema.parse(input);
  return digestCanonical(envelopePayload(parsed));
};

/** Recomputes the independently addressable digest of the redacted check summary. */
export const computeChangeEnvelopeEvidenceDigest = (input: unknown): FileDigest => {
  const parsed = changeEnvelopeEvidenceSchema.parse(input);
  return digestCanonical(evidencePayload(parsed.checks));
};

export const changeEnvelopePreconditionsSchema = z.strictObject({
  envelopeId: fileDigestSchema.optional(),
  baseWorkspaceDigest: fileDigestSchema.optional(),
  baseTreeDigest: fileDigestSchema.optional(),
  patchId: boundedIdentifierSchema.optional(),
  patchDigest: fileDigestSchema.optional(),
  harnessFingerprint: fileDigestSchema.optional(),
  policyFingerprint: fileDigestSchema.optional(),
  environmentFingerprint: fileDigestSchema.optional(),
  evidenceDigest: fileDigestSchema.optional(),
  requiredPassedChecks: z.array(boundedIdentifierSchema).max(MAX_CHANGE_ENVELOPE_CHECKS).optional(),
  requiredApprovalDigests: z.array(fileDigestSchema).max(MAX_CHANGE_ENVELOPE_APPROVALS).optional(),
  requiredApprovalScopes: z.array(approvalScopeSchema).max(MAX_CHANGE_ENVELOPE_APPROVAL_SCOPES).optional(),
  requiredAttestationDigests: z.array(fileDigestSchema).max(MAX_CHANGE_ENVELOPE_ATTESTATIONS).optional()
}).superRefine((preconditions, context) => {
  if (preconditions.requiredPassedChecks) {
    addDuplicateIssues(preconditions.requiredPassedChecks, (checkId) => checkId, context, "requiredPassedCheck");
  }
  if (preconditions.requiredApprovalDigests) {
    addDuplicateIssues(
      preconditions.requiredApprovalDigests,
      (digest) => digest,
      context,
      "requiredApprovalDigest"
    );
  }
  if (preconditions.requiredApprovalScopes) {
    addDuplicateIssues(preconditions.requiredApprovalScopes, (scope) => scope, context, "requiredApprovalScope");
  }
  if (preconditions.requiredAttestationDigests) {
    addDuplicateIssues(
      preconditions.requiredAttestationDigests,
      (digest) => digest,
      context,
      "requiredAttestationDigest"
    );
  }
});

export type ChangeEnvelopePreconditions = z.infer<typeof changeEnvelopePreconditionsSchema>;

export interface ChangeEnvelopeVerificationOptions {
  now?: Date | string | number;
  preconditions?: ChangeEnvelopePreconditions;
}

export type ChangeEnvelopeVerificationIssueCode =
  | "invalid-schema"
  | "envelope-digest-mismatch"
  | "evidence-digest-mismatch"
  | "envelope-not-yet-valid"
  | "envelope-expired"
  | "approval-expired"
  | "precondition-mismatch"
  | "missing-passed-check"
  | "missing-approval-digest"
  | "missing-approval-scope"
  | "missing-attestation-digest";

export interface ChangeEnvelopeVerificationIssue {
  code: ChangeEnvelopeVerificationIssueCode;
  path: readonly (string | number)[];
  message: string;
  expected?: string;
  actual?: string;
}

export interface ChangeEnvelopeVerificationResult {
  valid: boolean;
  verificationScope: "integrity-expiration-and-preconditions-only";
  envelope?: ChangeEnvelope;
  issues: ChangeEnvelopeVerificationIssue[];
  integrity: {
    envelopeDigestValid: boolean;
    evidenceDigestValid: boolean;
  };
  expiration: {
    checkedAt: string;
    envelopeNotYetValid: boolean;
    envelopeExpired: boolean;
    expiredApprovalIds: string[];
  };
  checks: {
    recorded: number;
    passed: string[];
    failed: string[];
    skipped: string[];
    requiredPassed: string[];
    missingPassed: string[];
  };
  approvals: {
    recorded: number;
    requiredScopes: string[];
    missingScopes: string[];
    authenticity: "not-verified";
  };
  externalAttestations: {
    referenced: number;
    requiredDigests: FileDigest[];
    missingDigests: FileDigest[];
    authenticity: "not-verified";
  };
}

const verificationOptionsSchema = z.strictObject({
  now: z.union([z.date(), z.number().int(), timestampSchema]).optional(),
  preconditions: changeEnvelopePreconditionsSchema.optional()
});

const verificationTime = (value: Date | string | number | undefined) => {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Verification time must be a valid date.");
  return date;
};

/**
 * Verifies schema, content digests, expiry, and caller-supplied preconditions
 * without network access. Approval and attestation references are integrity
 * bound only: their issuer/signature authenticity must be checked by an
 * external Sigstore/in-toto (or equivalent) verifier.
 */
export const verifyChangeEnvelope = (
  input: unknown,
  options: ChangeEnvelopeVerificationOptions = {}
): ChangeEnvelopeVerificationResult => {
  const parsedOptions = verificationOptionsSchema.parse(options);
  const now = verificationTime(parsedOptions.now);
  const checkedAt = now.toISOString();
  const parsedEnvelope = changeEnvelopeSchema.safeParse(input);
  if (!parsedEnvelope.success) {
    return {
      valid: false,
      verificationScope: "integrity-expiration-and-preconditions-only",
      issues: parsedEnvelope.error.issues.map((issue) => ({
        code: "invalid-schema",
        path: issue.path.map((segment) => typeof segment === "symbol" ? segment.description ?? "symbol" : segment),
        message: issue.message
      })),
      integrity: { envelopeDigestValid: false, evidenceDigestValid: false },
      expiration: { checkedAt, envelopeNotYetValid: false, envelopeExpired: false, expiredApprovalIds: [] },
      checks: {
        recorded: 0,
        passed: [],
        failed: [],
        skipped: [],
        requiredPassed: [...(parsedOptions.preconditions?.requiredPassedChecks ?? [])].sort(),
        missingPassed: [...(parsedOptions.preconditions?.requiredPassedChecks ?? [])].sort()
      },
      approvals: {
        recorded: 0,
        requiredScopes: [...(parsedOptions.preconditions?.requiredApprovalScopes ?? [])].sort(),
        missingScopes: [...(parsedOptions.preconditions?.requiredApprovalScopes ?? [])].sort(),
        authenticity: "not-verified"
      },
      externalAttestations: {
        referenced: 0,
        requiredDigests: [...(parsedOptions.preconditions?.requiredAttestationDigests ?? [])].sort(),
        missingDigests: [...(parsedOptions.preconditions?.requiredAttestationDigests ?? [])].sort(),
        authenticity: "not-verified"
      }
    };
  }

  const envelope = parsedEnvelope.data;
  const issues: ChangeEnvelopeVerificationIssue[] = [];
  const computedEvidenceDigest = digestCanonical(evidencePayload(envelope.evidence.checks));
  const evidenceDigestValid = computedEvidenceDigest === envelope.evidence.evidenceDigest;
  if (!evidenceDigestValid) {
    issues.push({
      code: "evidence-digest-mismatch",
      path: ["evidence", "evidenceDigest"],
      message: "Evidence digest does not match the canonical redacted check summary.",
      expected: computedEvidenceDigest,
      actual: envelope.evidence.evidenceDigest
    });
  }

  const computedEnvelopeDigest = digestCanonical(envelopePayload(envelope));
  const envelopeDigestValid = computedEnvelopeDigest === envelope.envelopeId;
  if (!envelopeDigestValid) {
    issues.push({
      code: "envelope-digest-mismatch",
      path: ["envelopeId"],
      message: "Envelope digest does not match its canonical payload.",
      expected: computedEnvelopeDigest,
      actual: envelope.envelopeId
    });
  }

  const envelopeNotYetValid = now.getTime() < Date.parse(envelope.createdAt);
  if (envelopeNotYetValid) {
    issues.push({
      code: "envelope-not-yet-valid",
      path: ["createdAt"],
      message: "Change envelope creation time is in the future."
    });
  }

  const envelopeExpired = envelope.expiresAt !== undefined && now.getTime() >= Date.parse(envelope.expiresAt);
  if (envelopeExpired) {
    issues.push({
      code: "envelope-expired",
      path: ["expiresAt"],
      message: "Change envelope has expired."
    });
  }

  const expiredApprovalIds = (envelope.approvals ?? [])
    .filter((approval) => approval.expiresAt !== undefined && now.getTime() >= Date.parse(approval.expiresAt))
    .map((approval) => approval.approvalId);
  for (const approvalId of expiredApprovalIds) {
    issues.push({
      code: "approval-expired",
      path: ["approvals", envelope.approvals?.findIndex((approval) => approval.approvalId === approvalId) ?? 0, "expiresAt"],
      message: `Recorded approval has expired: ${approvalId}.`
    });
  }

  const preconditions = parsedOptions.preconditions;
  const comparePrecondition = (
    field: string,
    expected: string | undefined,
    actual: string,
    path: readonly (string | number)[]
  ) => {
    if (expected !== undefined && expected !== actual) {
      issues.push({
        code: "precondition-mismatch",
        path,
        message: `Change envelope precondition does not match: ${field}.`,
        expected,
        actual
      });
    }
  };
  comparePrecondition("envelopeId", preconditions?.envelopeId, envelope.envelopeId, ["envelopeId"]);
  comparePrecondition(
    "baseWorkspaceDigest",
    preconditions?.baseWorkspaceDigest,
    envelope.base.workspaceDigest,
    ["base", "workspaceDigest"]
  );
  comparePrecondition("baseTreeDigest", preconditions?.baseTreeDigest, envelope.base.treeDigest, ["base", "treeDigest"]);
  comparePrecondition("patchId", preconditions?.patchId, envelope.patch.patchId, ["patch", "patchId"]);
  comparePrecondition("patchDigest", preconditions?.patchDigest, envelope.patch.patchDigest, ["patch", "patchDigest"]);
  comparePrecondition(
    "harnessFingerprint",
    preconditions?.harnessFingerprint,
    envelope.fingerprints.harness,
    ["fingerprints", "harness"]
  );
  comparePrecondition(
    "policyFingerprint",
    preconditions?.policyFingerprint,
    envelope.fingerprints.policy,
    ["fingerprints", "policy"]
  );
  comparePrecondition(
    "environmentFingerprint",
    preconditions?.environmentFingerprint,
    envelope.fingerprints.environment,
    ["fingerprints", "environment"]
  );
  comparePrecondition(
    "evidenceDigest",
    preconditions?.evidenceDigest,
    envelope.evidence.evidenceDigest,
    ["evidence", "evidenceDigest"]
  );

  const passedChecks = envelope.evidence.checks
    .filter((check) => check.status === "passed")
    .map((check) => check.checkId);
  const failedChecks = envelope.evidence.checks
    .filter((check) => check.status === "failed")
    .map((check) => check.checkId);
  const skippedChecks = envelope.evidence.checks
    .filter((check) => check.status === "skipped")
    .map((check) => check.checkId);
  const passedCheckSet = new Set(passedChecks);
  const requiredPassed = [...(preconditions?.requiredPassedChecks ?? [])].sort();
  const missingPassed = requiredPassed.filter((checkId) => !passedCheckSet.has(checkId));
  for (const checkId of missingPassed) {
    issues.push({
      code: "missing-passed-check",
      path: ["evidence", "checks"],
      message: `Required passed check is not recorded: ${checkId}.`,
      expected: checkId
    });
  }

  const expiredApprovals = new Set(expiredApprovalIds);
  const activeApprovals = (envelope.approvals ?? []).filter((approval) => !expiredApprovals.has(approval.approvalId));
  const approvalDigests = new Set(activeApprovals.map((approval) => approval.approvalDigest));
  for (const requiredDigest of preconditions?.requiredApprovalDigests ?? []) {
    if (!approvalDigests.has(requiredDigest)) {
      issues.push({
        code: "missing-approval-digest",
        path: ["approvals"],
        message: `Required active approval digest is not recorded: ${requiredDigest}.`,
        expected: requiredDigest
      });
    }
  }
  const approvedScopes = new Set(activeApprovals.flatMap((approval) => approval.scopes));
  const requiredScopes = [...(preconditions?.requiredApprovalScopes ?? [])].sort();
  const missingScopes = requiredScopes.filter((scope) => !approvedScopes.has(scope));
  for (const scope of missingScopes) {
    issues.push({
      code: "missing-approval-scope",
      path: ["approvals"],
      message: `Required active approval scope is not recorded: ${scope}.`,
      expected: scope
    });
  }

  const attestationDigests = new Set(
    (envelope.externalAttestations ?? []).map((attestation) => attestation.bundleDigest)
  );
  const requiredAttestationDigests = [...(preconditions?.requiredAttestationDigests ?? [])].sort();
  const missingAttestationDigests = requiredAttestationDigests.filter((digest) => !attestationDigests.has(digest));
  for (const requiredDigest of missingAttestationDigests) {
    issues.push({
      code: "missing-attestation-digest",
      path: ["externalAttestations"],
      message: `Required external attestation digest is not referenced: ${requiredDigest}.`,
      expected: requiredDigest
    });
  }

  return {
    valid: issues.length === 0,
    verificationScope: "integrity-expiration-and-preconditions-only",
    envelope,
    issues,
    integrity: { envelopeDigestValid, evidenceDigestValid },
    expiration: { checkedAt, envelopeNotYetValid, envelopeExpired, expiredApprovalIds },
    checks: {
      recorded: envelope.evidence.checks.length,
      passed: passedChecks,
      failed: failedChecks,
      skipped: skippedChecks,
      requiredPassed,
      missingPassed
    },
    approvals: {
      recorded: envelope.approvals?.length ?? 0,
      requiredScopes,
      missingScopes,
      authenticity: "not-verified"
    },
    externalAttestations: {
      referenced: envelope.externalAttestations?.length ?? 0,
      requiredDigests: requiredAttestationDigests,
      missingDigests: missingAttestationDigests,
      authenticity: "not-verified"
    }
  };
};
