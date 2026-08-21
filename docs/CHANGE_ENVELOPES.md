# Change envelopes

Zhivex Harness `0.9.x` adds `ChangeEnvelope v1`: a content-addressed change-admission document that can be produced by any coding agent and verified offline before another system accepts its patch artifact. It is a portable evidence contract, not a new patch format and not a replacement for the harness approval/import boundary.

## What it proves

An envelope binds these values into one canonical SHA-256 identifier:

- the logical workspace and exact source-tree digests supplied by the producer;
- an artifact identifier and the SHA-256 digest of the exact patch bytes;
- harness, policy, and execution-environment fingerprints;
- structured check status, timing, exit code, and optional digests of redacted output or the check runner;
- optional expiry, approval references/scopes, and external-attestation references.

Verification checks the strict schema, canonical envelope and evidence digests, rejects a future creation time, enforces expiry, exact patch bytes, and any caller-supplied preconditions. A check cannot complete after the envelope is created. Raw command output, prompts, approval reasoning, and credentials are intentionally not representable.

## Create and verify

The CLI is provider-free and performs no network requests. `create` reads the exact patch bytes, computes `patch.patchDigest`, rejects a conflicting declared digest, and writes canonical JSON to stdout:

```bash
zhx changes create examples/change-envelope-input.json \
  --patch examples/change.patch > change-envelope.json
```

Verify the envelope against those same bytes:

```bash
zhx changes verify change-envelope.json \
  --patch examples/change.patch
```

Verification returns a `change-envelope-verification` JSON document. Exit `0` means every integrity, expiration, and supplied-precondition check passed; exit `1` means the document is well-formed enough to report but is not admissible. Invalid CLI syntax or an unreadable/non-JSON artifact returns exit `2`.

For deterministic replay, `--now <ISO-8601>` selects the verification instant. Production admission should normally omit it and use the current clock.

## Input contract

The creation input is strict JSON:

```json
{
  "createdAt": "2026-08-20T12:00:00.000Z",
  "expiresAt": "2026-08-21T12:00:00.000Z",
  "base": {
    "workspaceDigest": "sha256:...",
    "treeDigest": "sha256:..."
  },
  "patch": {
    "patchId": "candidate-42"
  },
  "fingerprints": {
    "harness": "sha256:...",
    "policy": "sha256:...",
    "environment": "sha256:..."
  },
  "checks": [
    {
      "checkId": "tests",
      "status": "passed",
      "redacted": true,
      "startedAt": "2026-08-20T11:59:00.000Z",
      "completedAt": "2026-08-20T11:59:01.000Z",
      "durationMs": 1000,
      "exitCode": 0,
      "redactedOutputDigest": "sha256:..."
    }
  ]
}
```

The CLI fills `patchDigest` from `--patch`; the library-level `createChangeEnvelope` input requires it explicitly. Timestamps use millisecond-precision ISO-8601 UTC. Checks, approvals, scopes, and attestations are sorted canonically, so semantically identical set-like inputs produce the same envelope ID.

`workspaceDigest` identifies the governed workspace/scope chosen by the producer. `treeDigest` identifies the exact base tree to which the candidate applies. The envelope validates that these are SHA-256 values and binds them, but it does not guess their meaning or compute them from a Git repository: the admission system must supply and verify the correct values for its own source-control model.

## Verification preconditions

Pass a strict JSON object with `--preconditions` when an admission system has expected values:

```json
{
  "baseTreeDigest": "sha256:...",
  "harnessFingerprint": "sha256:...",
  "policyFingerprint": "sha256:...",
  "environmentFingerprint": "sha256:...",
  "requiredPassedChecks": ["tests", "typecheck"],
  "requiredApprovalScopes": ["workspace:write", "checks:accept"],
  "requiredAttestationDigests": ["sha256:..."]
}
```

Supported preconditions cover the envelope ID, workspace/tree, patch ID/digest, harness/policy/environment, evidence digest, required passing check IDs, active approval digests/scopes, and referenced external-attestation bundle digests. The CLI always adds the digest of the exact `--patch` bytes and rejects a conflicting value in the precondition file. A recorded failed or skipped check is evidence, but it satisfies no `requiredPassedChecks` entry.

## Authenticity boundary

`ChangeEnvelope v1` is content-addressed, not signed. Anyone who can replace an envelope can recompute its SHA-256 identifiers. The verifier therefore reports:

```text
verificationScope = integrity-expiration-and-preconditions-only
approvals.authenticity = not-verified
externalAttestations.authenticity = not-verified
```

An `externalAttestations` entry binds only an attestation ID, format, media type, and bundle digest. Validate the referenced Sigstore, in-toto, SLSA, or organization-specific bundle with its native trust policy, then pass its expected digest as an admission precondition. Never treat a recorded approval reference as proof of who approved it.

## Library API

The package exports `createChangeEnvelope`, `verifyChangeEnvelope`, `canonicalizeChangeEnvelope`, `digestChangeEnvelopeArtifact`, the digest recomputation helpers, strict Zod schemas, and all corresponding TypeScript types. This keeps the contract agent-agnostic: a CI gate, code-review bot, local harness, or deployment controller can produce or consume the same document.

## Known limits

- The CLI binds a supplied patch artifact but does not apply it, infer a Git base, run checks, or mint approvals.
- Check evidence is a redacted summary supplied by the producer; a trusted runner fingerprint or external attestation is needed when provenance matters.
- Creation-time and expiration decisions depend on the verifier's clock.
- SHA-256 integrity does not provide signer identity, transparency logging, revocation, or policy authorization.
- The v1 contract supports bounded UTF-8 JSON metadata and a patch artifact of at most 64 MiB; large binary release artifacts need a separate artifact policy.
