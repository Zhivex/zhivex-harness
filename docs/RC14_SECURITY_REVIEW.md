# RC.14 security review dossier

Current decision: the [delegated AI review](RC14_DELEGATED_SECURITY_DECISION.md) is complete, with no identified open critical/high findings. Its machine-readable result is `../security-reviews/rc14-review.json` in the source checkout. This is an explicitly authorized exception to human authorship, not a human signature. The original preparation instructions and pending draft below are retained as history.

## Historical preparation instructions

This dossier prepares the independent human review required by HAR-HU-03. It is not a completed security review and does not authorize GA. The machine-prepared `../security-reviews/rc14-review-draft.json` (source checkout) deliberately fails the passing-review schema: reviewer, date, coverage decisions, and findings must be supplied or confirmed by the human reviewer. Copied control-map text is a review starting point, not evidence that the reviewer assessed it. The draft includes all four known findings with their technically verified remediation; the reviewer must confirm dispositions, supply owners, and add any further findings. Their presence does not establish a completed human review.

The draft now includes machine-prepared source and regression references for all 10 controls, 11 trust boundaries and 31 authority-bearing tools. Technical notes incorporate the published RC14 remediation evidence; they do not carry forward the original pre-remediation findings as current defects. Residual-risk statements are proposed review inputs, not accepted risks. Every coverage decision remains pending, and reviewer identity, timestamp and finding owners remain unset. Source paths refer to the exact candidate commit below; the original automated review remains historical evidence.

## Exact candidate

- Tag: `v1.0.0-rc.14`
- Commit: `d1c5abcc6d1fa482c211c4327c86f592663d559b`
- npm: `@zhivex-ai/harness@1.0.0-rc.14` on `next`
- SHA-512: `sha512-UMu4JFUNs/kOTJETZSJMMvVYlo+a4MKG6PoSvE313QxMEqK1z420AXVgPOGJ8jj2jp6mQud/Rvc7+ixKyH/4og==`
- [Protected release, audit, OCI, and 42 representative cases](https://github.com/Zhivex/zhivex-harness/actions/runs/35510484383)
- [CI at the candidate commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35510241338)
- [CodeQL at the candidate commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35510241346)
- [Registry attestation](https://registry.npmjs.org/-/npm/v1/attestations/@zhivex-ai%2fharness@1.0.0-rc.14)

The release completed successfully. Meta, Qwen, and OpenAI each passed the complete 14-case inventory. Independent verification matched the published bytes, dist-tag, SLSA source/workflow binding, and exact artifact content; the protected workflow also installed and exercised the same tarball. This evidence does not replace human assessment of residual risk.

## Reviewer work

1. Inspect the exact tag and published artifact; verify its hash and provenance. Review [the threat model](THREAT_MODEL.md), [control map](../contracts/security-controls.json), and [schema requirements](SECURITY_REVIEW_EVIDENCE.md).
2. Review all controls, trust boundaries, and authority-bearing tools enumerated in the draft. For every entry record the mitigation actually reviewed, regression evidence, and residual risk. Check approval replay/substitution, hostile repository instructions, protected files and symlinks, SQLite scope/concurrency, subprocess/OCI boundaries, MCP, delegation, credentials, and supply-chain identity.
3. Review the RC.14 changes: cross-process mutation locks; full replacement review; complete OCI scope identity; required verified delivery; bounded tool selection, planning and verifier recovery; durable usage and closure reserves; terminal provider usage/tool-call fixes; task memory and candidate export scope. Inspect implementations and regression evidence, including [the tagged security regressions](reports/evidence/rc14-security-regressions-2026-09-20.json), rather than relying solely on green CI.
4. Record all findings, including resolved ones. Non-informational findings require owner, disposition, rationale, and HTTPS follow-up. Critical/high findings must be mitigated and resolved, not merely accepted. If a fix changes runtime code, create and certify a new immutable candidate before final review.
5. Supply your name, HTTPS identity, and actual UTC review timestamp. Only mark reviewed coverage and the document `passed` after completing the review. Save the completed JSON as `security-reviews/rc14-review.json` and submit it for validation. Do not invent a passing status to satisfy the schema.

## Mechanical promotion after review

Validate the completed JSON against `scripts/security-review-evidence.ts`, update the ledger from its actual timestamp and finding counts, and close the security blocker through reviewed evidence. Then prepare exact `1.0.0` version/lockfile/changelog changes, set readiness to `ready`, and run `bun run readiness:1.0:release` plus the complete release checks. Merge the promotion changes before creating the annotated `v1.0.0` tag and dispatching the protected release to `latest`. Verify npm integrity, provenance, installation, and rollback references afterward. The reviewer is not required to publish or approve npm deployment.

## Evaluation limits

The protected representative matrix passed 42/42 cases on this exact artifact. The separate fresh SWE-bench exploratory cohort remains 0/5 for Harness versus 1/5 for control, and its subsequent known-case development rerun remained unresolved. Those failures are preserved in [the recovery report](reports/GA_REPAIR_RECOVERY_2026-09-19.md); representative certification does not replace them or establish broad coding-agent accuracy.

The post-publication [GA gate result](reports/evidence/rc14-ga-gate-2026-09-20.json) retains five explicit failures: package version, readiness phase, open security blocker, missing passing review and missing review evidence path. Published RC and representative verification produced no additional failures. That gate record is historical. The completed delegated review closes the security-specific failures; package version, readiness phase and stable publication remain separate promotion work.
