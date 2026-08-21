import { describe, expect, test } from "bun:test";

import {
  CHANGE_ENVELOPE_SCHEMA_VERSION,
  canonicalizeChangeEnvelope,
  changeEnvelopeInputSchema,
  computeChangeEnvelopeDigest,
  computeChangeEnvelopeEvidenceDigest,
  createChangeEnvelope,
  digestChangeEnvelopeArtifact,
  verifyChangeEnvelope,
  type CreateChangeEnvelopeInput
} from "../src/change-envelope.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const fixtureInput = (): CreateChangeEnvelopeInput => ({
  createdAt: "2026-08-20T12:00:00.000Z",
  expiresAt: "2026-08-20T14:00:00.000Z",
  base: {
    workspaceDigest: digest("1"),
    treeDigest: digest("2")
  },
  patch: {
    patchId: digest("3"),
    patchDigest: digest("4")
  },
  fingerprints: {
    harness: digest("5"),
    policy: digest("6"),
    environment: digest("7")
  },
  checks: [
    {
      checkId: "typecheck",
      status: "passed",
      redacted: true,
      startedAt: "2026-08-20T11:58:00.000Z",
      completedAt: "2026-08-20T11:58:01.500Z",
      durationMs: 1_500,
      exitCode: 0,
      redactedOutputDigest: digest("8")
    },
    {
      checkId: "tests",
      status: "passed",
      redacted: true,
      startedAt: "2026-08-20T11:59:00.000Z",
      completedAt: "2026-08-20T11:59:02.000Z",
      durationMs: 2_000,
      exitCode: 0,
      runnerFingerprint: digest("9")
    }
  ],
  approvals: [
    {
      kind: "approval-reference",
      approvalId: "approval-write",
      approvalDigest: digest("a"),
      approverDigest: digest("b"),
      scopes: ["workspace:write", "checks:accept"],
      approvedAt: "2026-08-20T11:57:00.000Z",
      expiresAt: "2026-08-20T13:00:00.000Z"
    }
  ],
  externalAttestations: [
    {
      kind: "external-attestation-reference",
      attestationId: "sigstore-bundle",
      format: "sigstore.bundle.v0.3",
      mediaType: "application/vnd.dev.sigstore.bundle+json",
      bundleDigest: digest("c")
    }
  ]
});

describe("ChangeEnvelope v1", () => {
  test("creates a deterministic canonical envelope independent of set-like input order", () => {
    const input = fixtureInput();
    const first = createChangeEnvelope(input);
    const reordered = createChangeEnvelope({
      ...input,
      checks: [...input.checks].reverse(),
      approvals: input.approvals
        ? input.approvals.map((approval) => ({ ...approval, scopes: [...approval.scopes].reverse() }))
        : undefined,
      externalAttestations: input.externalAttestations
        ? [...input.externalAttestations].reverse()
        : undefined
    });

    expect(first.schemaVersion).toBe(CHANGE_ENVELOPE_SCHEMA_VERSION);
    expect(first.envelopeId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.envelopeId).toBe(reordered.envelopeId);
    expect(first.evidence.evidenceDigest).toBe(reordered.evidence.evidenceDigest);
    expect(first.evidence.checks.map((check) => check.checkId)).toEqual(["tests", "typecheck"]);
    expect(first.approvals?.[0]?.scopes).toEqual(["checks:accept", "workspace:write"]);
    expect(canonicalizeChangeEnvelope(first)).toBe(canonicalizeChangeEnvelope(reordered));
    expect(computeChangeEnvelopeDigest(first)).toBe(first.envelopeId);
    expect(computeChangeEnvelopeEvidenceDigest(first.evidence)).toBe(first.evidence.evidenceDigest);
    expect(digestChangeEnvelopeArtifact(new TextEncoder().encode("patch bytes\n")))
      .toBe(digestChangeEnvelopeArtifact("patch bytes\n"));
  });

  test("verifies integrity, expiry, bindings, active scopes, and explicit authenticity limits offline", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const result = verifyChangeEnvelope(envelope, {
      now: "2026-08-20T12:30:00.000Z",
      preconditions: {
        envelopeId: envelope.envelopeId,
        baseWorkspaceDigest: envelope.base.workspaceDigest,
        baseTreeDigest: envelope.base.treeDigest,
        patchId: envelope.patch.patchId,
        patchDigest: envelope.patch.patchDigest,
        harnessFingerprint: envelope.fingerprints.harness,
        policyFingerprint: envelope.fingerprints.policy,
        environmentFingerprint: envelope.fingerprints.environment,
        evidenceDigest: envelope.evidence.evidenceDigest,
        requiredPassedChecks: ["tests", "typecheck"],
        requiredApprovalDigests: [digest("a")],
        requiredApprovalScopes: ["workspace:write", "checks:accept"],
        requiredAttestationDigests: [digest("c")]
      }
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.integrity).toEqual({ envelopeDigestValid: true, evidenceDigestValid: true });
    expect(result.approvals).toMatchObject({
      recorded: 1,
      missingScopes: [],
      authenticity: "not-verified"
    });
    expect(result.checks).toMatchObject({
      recorded: 2,
      passed: ["tests", "typecheck"],
      missingPassed: []
    });
    expect(result.externalAttestations).toMatchObject({
      referenced: 1,
      missingDigests: [],
      authenticity: "not-verified"
    });
    expect(result.verificationScope).toBe("integrity-expiration-and-preconditions-only");
  });

  test("detects patch and envelope-id tampering", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const tamperedPatch = structuredClone(envelope);
    tamperedPatch.patch.patchDigest = digest("d");
    const patchResult = verifyChangeEnvelope(tamperedPatch, {
      now: "2026-08-20T12:30:00.000Z",
      preconditions: { patchDigest: envelope.patch.patchDigest }
    });

    expect(patchResult.valid).toBe(false);
    expect(patchResult.issues.map((issue) => issue.code)).toContain("envelope-digest-mismatch");
    expect(patchResult.issues.map((issue) => issue.code)).toContain("precondition-mismatch");

    const tamperedId = { ...envelope, envelopeId: digest("e") };
    expect(verifyChangeEnvelope(tamperedId, { now: "2026-08-20T12:30:00.000Z" }).issues)
      .toContainEqual(expect.objectContaining({ code: "envelope-digest-mismatch", path: ["envelopeId"] }));
  });

  test("detects changes to the base, policy, and redacted evidence", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const cases = [
      {
        mutate: (candidate: typeof envelope) => { candidate.base.treeDigest = digest("d"); },
        preconditions: { baseTreeDigest: envelope.base.treeDigest }
      },
      {
        mutate: (candidate: typeof envelope) => { candidate.fingerprints.policy = digest("e"); },
        preconditions: { policyFingerprint: envelope.fingerprints.policy }
      },
      {
        mutate: (candidate: typeof envelope) => {
          candidate.evidence.checks[0]!.redactedOutputDigest = digest("f");
        },
        preconditions: { evidenceDigest: envelope.evidence.evidenceDigest }
      }
    ] as const;

    for (const fixture of cases) {
      const candidate = structuredClone(envelope);
      fixture.mutate(candidate);
      const result = verifyChangeEnvelope(candidate, {
        now: "2026-08-20T12:30:00.000Z",
        preconditions: fixture.preconditions
      });
      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("envelope-digest-mismatch");
    }

    const evidenceTamper = structuredClone(envelope);
    evidenceTamper.evidence.checks[0]!.durationMs += 1;
    expect(verifyChangeEnvelope(evidenceTamper, { now: "2026-08-20T12:30:00.000Z" }).issues)
      .toContainEqual(expect.objectContaining({ code: "evidence-digest-mismatch" }));
  });

  test("fails closed when the envelope or a required approval expires", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const notYetValid = verifyChangeEnvelope(envelope, { now: "2026-08-20T11:59:59.999Z" });
    expect(notYetValid.valid).toBe(false);
    expect(notYetValid.expiration.envelopeNotYetValid).toBe(true);
    expect(notYetValid.issues.map((issue) => issue.code)).toContain("envelope-not-yet-valid");

    const approvalExpired = verifyChangeEnvelope(envelope, {
      now: "2026-08-20T13:00:00.000Z",
      preconditions: { requiredApprovalScopes: ["workspace:write"] }
    });
    expect(approvalExpired.valid).toBe(false);
    expect(approvalExpired.issues.map((issue) => issue.code)).toContain("approval-expired");
    expect(approvalExpired.issues.map((issue) => issue.code)).toContain("missing-approval-scope");

    const envelopeExpired = verifyChangeEnvelope(envelope, { now: "2026-08-20T14:00:00.000Z" });
    expect(envelopeExpired.valid).toBe(false);
    expect(envelopeExpired.expiration.envelopeExpired).toBe(true);
    expect(envelopeExpired.issues.map((issue) => issue.code)).toContain("envelope-expired");
  });

  test("requires explicitly selected passing checks and attestation bundle digests", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const result = verifyChangeEnvelope(envelope, {
      now: "2026-08-20T12:30:00.000Z",
      preconditions: {
        requiredPassedChecks: ["security-scan"],
        requiredAttestationDigests: [digest("d")]
      }
    });

    expect(result.valid).toBe(false);
    expect(result.checks.missingPassed).toEqual(["security-scan"]);
    expect(result.externalAttestations.missingDigests).toEqual([digest("d")]);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "missing-passed-check",
      "missing-attestation-digest"
    ]));
  });

  test("strict schemas reject unknown fields and cannot carry raw output or approval reasoning", () => {
    const input = fixtureInput();
    expect(() => changeEnvelopeInputSchema.parse({ ...input, agentReasoning: "hidden chain" })).toThrow();
    expect(() => changeEnvelopeInputSchema.parse({
      ...input,
      checks: [{ ...input.checks[0], output: "token=secret" }]
    })).toThrow();
    expect(() => changeEnvelopeInputSchema.parse({
      ...input,
      approvals: [{ ...input.approvals![0], reason: "contains a prompt or secret" }]
    })).toThrow();
    expect(() => createChangeEnvelope({
      ...input,
      checks: [{
        ...input.checks[0],
        completedAt: "2026-08-20T12:00:00.001Z",
        durationMs: 120_001
      }]
    })).toThrow("later than envelope creation");

    const serialized = canonicalizeChangeEnvelope(createChangeEnvelope(input));
    expect(serialized).not.toContain("output\"");
    expect(serialized).not.toContain("reason");
    expect(serialized).not.toContain("secret");
  });

  test("reports strict schema failures without accepting a partially verified document", () => {
    const envelope = createChangeEnvelope(fixtureInput());
    const result = verifyChangeEnvelope({ ...envelope, unexpected: true }, {
      now: "2026-08-20T12:30:00.000Z"
    });

    expect(result.valid).toBe(false);
    expect(result.envelope).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid-schema" }));
  });
});
