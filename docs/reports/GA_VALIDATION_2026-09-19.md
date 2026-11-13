# Automated external GA validation — September 19, 2026

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../maintenance/LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

**Verdict: NO-GO for RC.14 / promotion to 1.0.0.** A functional blocker
is reproduced in Meta and OpenAI multi-turn flows with the default
budget. The existing suite passes but does not detect this combination.

Evaluator: Codex, acting as an automated external validator at the
operator's request. This report is not a human signature, a comprehensive security audit
or publication evidence. Runtime and GA criteria were not modified.

## Identity and reproducibility

- Commit: `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`.
- Version: `1.0.0-rc.14`; Bun 1.4.0, Node 22.21.0, macOS arm64.
- The commit was exported with `git archive` and its lockfile installed with
  `bun install --frozen-lockfile --ignore-scripts` in an isolated temporary directory.
- The original checkout had outdated dependencies and later received
  concurrent changes to `package.json`, `bun.lock` and `node_modules`. Final
  results come from the isolated copy; they do not certify those changes.
- [Structured evidence](evidence/ga-validation-2026-09-19.json): results,
  local tarball hash, versions, CI and diagnostics without provider content.
- The local tarball passed content inspection and independent installation of
  those exact bytes. It has neither protected release identity nor npm provenance.

## Executed results

| Boundary | Result |
| --- | --- |
| `ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run check` | PASS, exit 0 in isolated copy |
| Existing suite | 512/512 tests, 59 files |
| Docs, preparation contracts, source and tooling types | PASS |
| Historical migrations 0.10.0 / 0.11.1 | PASS |
| Deterministic evaluations | 7/7 |
| Workspace and scripted safe-fix benchmarks | PASS; do not establish model capability |
| MCP and official SDK interoperability | PASS |
| Real OCI | PASS, Docker 29.8.0, secrets excluded, network denied and governed import |
| Installed package and exact tarball | PASS |
| Dependency audit | BLOCKED: npm advisory service HTTP 503, two attempts |
| Untrusted dependency scripts | 0 |
| Formal `readiness:1.0:release` gate | FAIL: RC.14 incomplete, review pending, phase and version not promoted |

The OCI image used was
`node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`.

| Isolated-source live test | Meta muse-spark-1.2 | Qwen qwen3.8-max | OpenAI gpt-5.6-luna |
| --- | --- | --- | --- |
| Approval, persistence and restart | FAIL | PASS | FAIL |
| Orchestration, persisted child and reopening | PASS | PASS | PASS |
| OCI execution and host import | FAIL | PASS | FAIL |

OpenAI → Qwen routing: PASS, one delegation and one reviewer tool.
These smokes use existing credentials and temporary fixtures; they are not the
representative matrix of a protected release. Gemini is outside the GA cohort.

## Finding GA-01 — Functional P1: output reserve prevents the second turn

With `subagentProfiles: []`, Meta and OpenAI enable the transport budget in
`src/harness.ts` (`createProviderCompatibleBudget`) and `src/runtime-policy.ts`.
Integration with Core 1.14.0 requires the full output reserve again during
next-turn preflight. The reserve does not fit after initial usage:

| Provider | Limit | Consumed | Requested reserve | Available | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Meta | 30,000 | 2 | 30,000 | 29,998 | GuardrailTriggeredError, input stage |
| OpenAI | 30,000 | 2 | 30,000 | 29,998 | GuardrailTriggeredError, input stage |
| Qwen, control | 30,000 | 4 at completion | — | — | completed |

Reproduced without network or real model using a two-token first `list_files`
turn and a second completion turn. The output-budget guardrail was also
observed in additional diagnostics of live approval failures.
Live OCI failures have the same fingerprint; independent inspection of their
internal cause is not claimed.

Run from a checkout with the evaluated commit's lockfile:

```sh
bun run scripts/validate-ga-budget.ts
```

The new acceptance test exits with code 1 on the evaluated candidate; Qwen
acts as the positive control. It is not silently included as a green test.
The script validates completion, expected output, usage and tool execution.
It must pass for all three providers after correcting coordination between
cumulative budget and per-call reserve while maintaining limits and approvals.

## Remote evidence and pending work

The current query of [CI for the same commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35458111045)
showed both Node 22.13/24 consumer jobs green. macOS and Ubuntu tooling
jobs failed at dependency audit; the Ubuntu log confirms HTTP 503.
[CodeQL for the same commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35458110958)
passed. Advisory unavailability does not equal zero vulnerabilities.

Lifting NO-GO requires:

1. Fix GA-01 and repeat this acceptance and affected live smokes.
2. Resolve the repair-delivery hold recorded in
   [previous RC.14 validation](RC14_VALIDATION_2026-09-10.md), with a new
   cohort and predeclared criteria. This validation neither reran nor closed it.
3. Restore complete dependency audit and CI.
4. Certify the immutable final candidate: tag, artifact, OCI, live and full
   42-case representative matrix; verify publication and SLSA. No publication
   was dispatched and that matrix was not run on an already blocked candidate.
5. Complete security review of all final-candidate boundaries and tools
   with the identity required by current policy. The RC.13 draft
   does not cover RC.14 and this report does not replace its human signature.
6. Only then prepare version `1.0.0`, phase `ready` and run the formal gate.

No ledger statuses were changed, zero-security-finding claims made,
tags created or packages published. Full security review remains
pending, not approved by inference from green tests or CodeQL.
