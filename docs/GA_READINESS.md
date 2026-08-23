# 1.0 readiness

[`ga-readiness.json`](./ga-readiness.json) is the fail-closed source for the 1.0 promotion gate. `bun run readiness:1.0` validates the preparation assets on every change. `bun run readiness:1.0:release` is intentionally red until all blockers are closed, the security and representative evaluation evidence is complete and recent, two published RCs have zero known contract-breaking defects, and `package.json` is exactly `1.0.0`.

RC evidence is not accepted on self-report alone. In release mode the gate resolves each exact annotated tag, verifies its commit is reachable from `origin/main`, matches the publication timestamp and recorded SHA-512 integrity against the published npm version, validates the npm SLSA provenance, and checks the recorded successful release workflow through the GitHub API. The two candidates must have distinct tags, commits, artifacts, and workflow runs.

Representative evaluation requires exactly one complete result for every certified provider on every recorded RC. The ledger requires at least RC.1 and RC.2 and accepts later corrective candidates only as a contiguous sequence. Each provider row contains the complete individual-case inventory, derives its counts from those cases, rejects raw prompts/output, and is bound to the candidate tag, source commit, published artifact integrity, dataset, driver, OCI image, and workflow. The gate verifies the workflow remotely and rejects matrix drift or workflow reuse across candidates.

A passing security review must reference a strict JSON file under `security-reviews/` bound to the final recorded RC. The gate validates its reviewer, date, finding inventory, complete control/boundary/authority-bearing-tool coverage, artifact integrity and provenance, then verifies the exact CI, CodeQL, dependency-audit, release, and OCI workflow runs through GitHub. See [SECURITY_REVIEW_EVIDENCE.md](./SECURITY_REVIEW_EVIDENCE.md); status strings and paths alone are not evidence.

The preparation gate does not certify production readiness. It verifies that public API/CLI/schema baselines, migration targets, support claims, security controls, rollback rules, and evidence requirements remain machine-readable and internally consistent.

## Promotion sequence

1. Keep the completed contract, error, CLI-option, historical-migration, and state-backup gates green.
2. Publish `1.0.0-rc.1` to `next` through the protected exact-artifact workflow.
3. Run migration, representative repository, live provider, OCI, installed-artifact, integrity, and provenance gates against that tag.
4. Fix contract defects and publish `1.0.0-rc.2` to `next`; repeat the full matrix.
5. Record a current security review with no open critical/high findings.
6. Change the readiness phase to `ready` only after all evidence is committed and passes the release gate.
7. Publish `1.0.0` to `latest`; never promote an RC by merely moving a dist-tag.

Gemini is explicitly provisional and excluded from the 1.0 GA-certified cohort. The decision and its promotion criteria are recorded in [GEMINI_1_0_DECISION.md](./GEMINI_1_0_DECISION.md); partial or capacity-blocked evidence is never certification.
