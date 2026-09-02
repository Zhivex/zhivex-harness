# 1.0 readiness

[`ga-readiness.json`](./ga-readiness.json) is the fail-closed source for the 1.0 promotion gate. `bun run readiness:1.0` validates the preparation assets on every change. `bun run readiness:1.0:release` is intentionally red until all blockers are closed, the security and representative evaluation evidence is complete and recent, two published RCs have zero known contract-breaking defects, and `package.json` is exactly `1.0.0`.

RC evidence is not accepted on self-report alone. The ledger preserves every contiguous immutable attempt. A failed attempt must record its exact tag, commit, artifact integrity, workflow, observed time, failed gates, and non-publication state, but it does not count toward GA. If artifact binding fails before live gates begin, `liveCertification` is `not-run` and no downstream gate may be reported as passed or failed. In release mode the gate requires at least two passing candidates, resolves each passing annotated tag, verifies its commit is reachable from `origin/main`, matches the publication timestamp and recorded SHA-512 integrity against the published npm version, validates npm SLSA provenance, and checks the recorded successful release workflow through the GitHub API. The two passing candidates must have distinct tags, commits, artifacts, and workflow runs.

Representative evaluation requires exactly one complete result for every certified provider on every passing RC. The ledger starts at RC.1 and accepts later corrective attempts only as a contiguous sequence. Each provider row contains the complete individual-case inventory, derives its counts from those cases, rejects raw prompts/output, and is bound to the candidate tag, source commit, published artifact integrity, dataset, driver, OCI image, and workflow. The gate verifies the workflow remotely and rejects matrix drift or workflow reuse across passing candidates.

A passing security review must reference a strict JSON file under `security-reviews/` bound to the final recorded RC. The gate validates its reviewer, date, finding inventory, complete control/boundary/authority-bearing-tool coverage, artifact integrity and provenance, then verifies the exact CI, CodeQL, dependency-audit, release, and OCI workflow runs through GitHub. See [SECURITY_REVIEW_EVIDENCE.md](./SECURITY_REVIEW_EVIDENCE.md); status strings and paths alone are not evidence.

The preparation gate does not certify production readiness. It verifies that public API/CLI/schema baselines, migration targets, support claims, security controls, rollback rules, and evidence requirements remain machine-readable and internally consistent.

## Promotion sequence

1. Keep the completed contract, error, CLI-option, historical-migration, and state-backup gates green.
2. Preserve the failed, unpublished `1.0.0-rc.1` through `1.0.0-rc.6` attempts and the separate failed `1.0.0-rc.8` attempt with their protected-workflow evidence; never retag or reuse them.
3. Preserve the published `1.0.0-rc.7` evidence: its exact tag, artifact, live-provider gate, complete Meta/Qwen/OpenAI matrix, npm integrity, and SLSA provenance passed on the `next` channel.
4. Record that `1.0.0-rc.8` passed exact-tag readiness but failed artifact binding because the manual workflow packed before building `dist/`; OCI and provider gates did not run, no diagnostic artifact was produced, and npm publication was not dispatched.
5. Preserve `1.0.0-rc.9` as an immutable failed attempt: release-bound deterministic validation exposed an environment-sensitive diagnostic test before packing, so no release tarball was created and every live, representative, and npm job was skipped.
6. Preserve `1.0.0-rc.10` as an immutable failed attempt: its exact tarball passed artifact binding, but an OpenAI account-funding issue surfaced as retryable HTTP 500 failures in live and representative gates and Qwen resolved 13/14 representative cases; npm publication was skipped.
7. Preserve the published `1.0.0-rc.11` evidence: OpenAI's release precheck and Qwen's complete representative precheck passed, the protected workflow's first attempt failed closed on one Qwen representative case without publishing, and its complete second attempt passed every live and representative gate before publishing the exact artifact to `next` with verified npm integrity and SLSA provenance.
8. Treat RC.11 as immutable historical evidence rather than the final security-review target: HAR-HU-03 found and locally remediated two high-severity `git_diff` boundary defects, so the changed bytes require the separately authorized `v1.0.0-rc.12` candidate and complete protected recertification.
9. Record a current security review with no open critical/high findings against the final passing candidate.
10. Change the readiness phase to `ready` only after all evidence is committed and passes the release gate.
11. Publish `1.0.0` to `latest`; never promote an RC by merely moving a dist-tag.

Gemini is explicitly provisional and excluded from the 1.0 GA-certified cohort. The decision and its promotion criteria are recorded in [GEMINI_1_0_DECISION.md](./GEMINI_1_0_DECISION.md); partial or capacity-blocked evidence is never certification.
