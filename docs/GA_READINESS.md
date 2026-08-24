# 1.0 readiness

[`ga-readiness.json`](./ga-readiness.json) is the fail-closed source for the 1.0 promotion gate. `bun run readiness:1.0` validates the preparation assets on every change. `bun run readiness:1.0:release` is intentionally red until all blockers are closed, the security and representative evaluation evidence is complete and recent, two published RCs have zero known contract-breaking defects, and `package.json` is exactly `1.0.0`.

RC evidence is not accepted on self-report alone. The ledger preserves every contiguous immutable attempt. A failed attempt must record its exact tag, commit, artifact integrity, workflow, observed time, failed gates, and non-publication state, but it does not count toward GA. In release mode the gate requires at least two passing candidates, resolves each passing annotated tag, verifies its commit is reachable from `origin/main`, matches the publication timestamp and recorded SHA-512 integrity against the published npm version, validates npm SLSA provenance, and checks the recorded successful release workflow through the GitHub API. The two passing candidates must have distinct tags, commits, artifacts, and workflow runs.

Representative evaluation requires exactly one complete result for every certified provider on every passing RC. The ledger starts at RC.1 and accepts later corrective attempts only as a contiguous sequence. Each provider row contains the complete individual-case inventory, derives its counts from those cases, rejects raw prompts/output, and is bound to the candidate tag, source commit, published artifact integrity, dataset, driver, OCI image, and workflow. The gate verifies the workflow remotely and rejects matrix drift or workflow reuse across passing candidates.

A passing security review must reference a strict JSON file under `security-reviews/` bound to the final recorded RC. The gate validates its reviewer, date, finding inventory, complete control/boundary/authority-bearing-tool coverage, artifact integrity and provenance, then verifies the exact CI, CodeQL, dependency-audit, release, and OCI workflow runs through GitHub. See [SECURITY_REVIEW_EVIDENCE.md](./SECURITY_REVIEW_EVIDENCE.md); status strings and paths alone are not evidence.

The preparation gate does not certify production readiness. It verifies that public API/CLI/schema baselines, migration targets, support claims, security controls, rollback rules, and evidence requirements remain machine-readable and internally consistent.

## Promotion sequence

1. Keep the completed contract, error, CLI-option, historical-migration, and state-backup gates green.
2. Preserve the failed, unpublished `1.0.0-rc.1` and `1.0.0-rc.2` attempts and their protected-workflow evidence; never retag or reuse them.
3. Publish the forward-observable `1.0.0-rc.3` to `next` and run migration, representative repository, live provider, OCI, installed-artifact, integrity, and provenance gates against that exact tag.
4. Complete the observation cycle, publish an independent `1.0.0-rc.4` to `next`, and repeat the full matrix so RC.3 and RC.4 provide two passing candidates.
5. Record a current security review with no open critical/high findings against the final passing candidate.
6. Change the readiness phase to `ready` only after all evidence is committed and passes the release gate.
7. Publish `1.0.0` to `latest`; never promote an RC by merely moving a dist-tag.

Gemini is explicitly provisional and excluded from the 1.0 GA-certified cohort. The decision and its promotion criteria are recorded in [GEMINI_1_0_DECISION.md](./GEMINI_1_0_DECISION.md); partial or capacity-blocked evidence is never certification.
