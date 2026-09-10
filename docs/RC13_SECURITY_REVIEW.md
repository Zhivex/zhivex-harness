# RC.13 security review dossier

This dossier prepares the independent human review required by HAR-HU-03. It is not a completed security review and does not authorize GA. The machine-prepared `../security-reviews/rc13-review-draft.json` (source checkout) deliberately fails the passing-review schema: reviewer, date, coverage decisions, and findings must be supplied or confirmed by the human reviewer. Copied control-map text is a review starting point, not evidence that the reviewer assessed it. An empty findings array in the draft does not mean zero findings.

## Exact candidate

- Tag: `v1.0.0-rc.13`
- Commit: `d6e310ce12fd3ee74db5bd40451f5af70056e3ce`
- npm: `@zhivex-ai/harness@1.0.0-rc.13` on `next`
- SHA-512: `sha512-EhKcjH44ZvRS1Y4POhs2xnPCmw0IFQo1trKf1gusYaFMkLthwXND0+ZEkfzG25JFCCf7kfOAZabDp35SoPnubw==`
- [Protected release, audit, OCI, and 42 representative cases](https://github.com/Zhivex/zhivex-harness/actions/runs/34263591864)
- [CI at the candidate commit](https://github.com/Zhivex/zhivex-harness/actions/runs/34256076072)
- [CodeQL at the candidate commit](https://github.com/Zhivex/zhivex-harness/actions/runs/34256076032)
- [Registry attestation](https://registry.npmjs.org/-/npm/v1/attestations/@zhivex-ai%2fharness@1.0.0-rc.13)

The release completed successfully. Meta, Qwen, and OpenAI each passed the complete 14-case inventory. Independent verification matched the published bytes, dist-tag, SLSA source/workflow binding, and installed CLI version. This evidence does not replace human assessment of residual risk.

## Reviewer work

1. Inspect the exact tag and published artifact; verify its hash and provenance. Review [the threat model](THREAT_MODEL.md), [control map](../contracts/security-controls.json), and [schema requirements](SECURITY_REVIEW_EVIDENCE.md).
2. Review all controls, trust boundaries, and authority-bearing tools enumerated in the draft. For every entry record the mitigation actually reviewed, regression evidence, and residual risk. Check approval replay/substitution, hostile repository instructions, protected files and symlinks, SQLite scope/concurrency, subprocess/OCI boundaries, MCP, delegation, credentials, and supply-chain identity.
3. Include the RC.13 changes: personal profile filesystem protections; unsolicited terminal input and paste confirmation; attachment exclusion and digest checks; safe terminal output; interruption cleanup, optimistic revisions, and durable pending approvals. Inspect the corresponding tests and the implementation rather than relying solely on green CI.
4. Record all findings, including resolved ones. Non-informational findings require owner, disposition, rationale, and HTTPS follow-up. Critical/high findings must be mitigated and resolved, not merely accepted. If a fix changes runtime code, create and certify a new immutable candidate before final review.
5. Supply your name, HTTPS identity, and actual UTC review timestamp. Only mark reviewed coverage and the document `passed` after completing the review. Save the completed JSON as `security-reviews/rc13-review.json` and submit it for validation. Do not invent a passing status to satisfy the schema.

## Mechanical promotion after review

Validate the completed JSON against `scripts/security-review-evidence.ts`, update the ledger from its actual timestamp and finding counts, and close the security blocker through reviewed evidence. Then prepare exact `1.0.0` version/lockfile/changelog changes, set readiness to `ready`, and run `bun run readiness:1.0:release` plus the complete release checks. Merge the promotion changes before creating the annotated `v1.0.0` tag and dispatching the protected release to `latest`. Verify npm integrity, provenance, installation, and rollback references afterward. The reviewer is not required to publish or approve npm deployment.
