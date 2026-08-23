# Security review evidence

Harness 1.0 promotion requires one current, human-authored JSON review under `security-reviews/` bound to the final recorded release candidate. The reviewer must inspect the exact candidate, not a mutable branch or a different artifact.

The schema is implemented by `scripts/security-review-evidence.ts` and rejects unknown fields. A passing document records:

- the exact `v1.0.0-rc.N` tag, 40-character source commit, and canonical npm SHA-512 integrity;
- the reviewer's name and HTTPS identity plus a canonical UTC observation time;
- successful CI, CodeQL, dependency-audit, release, provenance, and OCI evidence;
- every finding, including resolved findings and open medium/low/informational observations; and
- every declared security control, trust boundary, and authority-bearing tool with its reviewed mitigation, regression evidence, and residual risk.

Open critical or high findings fail the gate. The control inventory must match `contracts/security-controls.json` exactly. CI and CodeQL evidence must be successful `push` runs at the candidate commit; dependency audit, release, and OCI evidence must come from the successful protected `release.yml` workflow dispatch. Shared evidence classes may reference that same release run. The gate resolves every workflow URL through the GitHub API and rejects a mismatched URL, commit, event, workflow path, status, or conclusion. It also resolves the exact version from the npm registry, requires the recorded attestation URL and artifact integrity to match registry metadata, validates the SLSA statement against the release commit and SHA-512 digest, and binds its invocation to the recorded release workflow.

The ledger fields in `docs/ga-readiness.json` are a summary only. Their timestamp and critical/high counts must equal the verified JSON inventory. Never mark the review passed until the published candidate integrity and provenance are available and a named reviewer has completed the review.
