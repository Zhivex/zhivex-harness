# RC14 delegated security decision

Historical candidate decision. Stable publication subsequently completed; see the
[current release evidence](LIVE_CERTIFICATION.md#current-public-status). This
record preserves the review scope and exception used for that candidate.

## Authorization and attribution

On 2026-09-20, technical security judgment for RC14 was explicitly delegated
to Codex after disclosure of the independent-human-review requirement.
This authorization is recorded as an AI review, not a human review.

For this exact RC14 promotion decision, the project records an explicit exception
to the independent human authorship requirement: the review is performed by
Codex, an AI assistant acting under that delegation. No human signature,
independent human audit, OpenAI organizational certification or external auditor
accreditation is asserted. This exception does not apply automatically to a new
candidate or future releases. The user has delegated judgment, not personally
attested to inspection of each source file or test.

The machine-readable review identifies Codex explicitly. Its HTTPS identity
identifies the Codex service, not a human reviewer. This policy decision is
reviewable in the same PR as the evidence. No evidence-validator code, severity
threshold, coverage inventory, provenance check or runtime approval is relaxed.

## Object and method

- Candidate: `v1.0.0-rc.14`, commit `d1c5abcc6d1fa482c211c4327c86f592663d559b`.
- Exact artifact identity and observation time: `../security-reviews/rc14-review.json` in the source checkout.
- Verification record: [delegated review evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/evidence/rc14-delegated-security-review-2026-09-20.json).
- Scope: 10 controls, 11 trust boundaries and 31 authority-bearing tool classes.

This review continues the directed source assessment recorded on 2026-09-19,
assesses the subsequent security and repair-controller changes, and binds the
decision to the final published candidate. Changes after that candidate are
documentation and evaluation evidence; runtime and dependency files are
unchanged. Historical review findings are preserved rather than erased.

The final assessment includes approval payload visibility and replay binding,
descriptor-bound repository reads, mutation concurrency, complete OCI scope
identity and import, scoped durable state, task memory, MCP authority, delegation,
subprocess isolation, budget failure accounting, bounded repair recovery,
personal profiles and publication identity. It is not an exhaustive audit of
all transitive dependency source or a proof that unknown vulnerabilities are absent.

Fresh validation passed the five adversarial checks (four original findings plus
the stale-digest control) and 137 security/regression tests across ten files,
with 659 assertions. Published bytes, the `next` tag and SLSA source/workflow
binding were reverified. The unchanged review validator also checks the exact
candidate's CI, CodeQL, dependency audit, OCI and protected release workflows.

## Findings and judgment

The four known findings are resolved by the changes merged in PR #77 and present
in the published candidate: `sec-04` (high, cross-scope OCI artifacts), `sec-01`
(medium, concurrent writes), `sec-02` (medium, replacement visibility), and
`sec-03` (low, incomplete authority inventory). Lowercase IDs in the final JSON
are the schema-compatible spellings of the historical uppercase IDs.

There are no identified open critical or high findings in this directed review.
The security decision is **passed under the explicit delegated-AI exception**,
within the documented threat model. This is not a statement that risk is zero.

Residual risks remain material: the host account/kernel/daemon and configured
service identities are trusted; approved services receive their inputs; pattern
redaction is incomplete; cooperative locks do not govern external writers or
provide power-loss atomicity for all files; approved host execution can run
repository code; a model-authored verifier may be inadequate. Simple
`apply_environment_patch` imports do not themselves execute a verifier. The
operator must assess the granted authority and verifier coverage.

The separate fresh SWE-bench cohort remains Harness 0/5 versus control 1/5.
The protected representative matrix passed 42/42 on RC14, but that does not
establish broad coding accuracy or reverse the exploratory result. This
decision addresses the security gate only.

## Historical promotion work

At the time of this decision, the security ledger could reference this completed review with the exception
visible in the readiness documentation. GA still required the exact `1.0.0`
version, readiness phase, release checks and protected stable publication,
followed by verification of its own artifact. No tag, dist-tag or package is
published by this review.
