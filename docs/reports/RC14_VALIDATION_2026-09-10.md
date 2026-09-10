# RC14 validation and publication hold

## Decision

RC14 is prepared but publication is held after the new live cohort exposed continuing delivery failures. This is a release-readiness judgment, not a failed protected release workflow or a claim that the benchmark has a predefined comparative score gate. No RC14 tag, workflow dispatch, or registry publication was performed. The readiness ledger remains pending; GA human security review remains open.

The frozen runtime is commit `0609f11681cf44d0fc68b7671ed4e37ceaf48309` on [PR #69](https://github.com/Zhivex/zhivex-harness/pull/69). All 66 implementation file hashes were verified against the final checkout and both archived source snapshots. Subsequent evidence-only changes do not alter that runtime.

## New live cohort

Two SWE-bench Verified tasks were selected with seed `20260910`, excluding all 15 tasks appearing in prior local manifests, before either provider ran. The selected tasks are `django__django-15128` and `django__django-15851`. Both use digest-pinned images, three repetitions, independent official grading, and the same frozen harness. Each provider matrix includes the unchanged mini-SWE-agent control.

| Configuration | Zhivex accepted deliveries | Correct Zhivex candidates | mini-SWE-agent accepted deliveries |
| --- | ---: | ---: | ---: |
| OpenAI gpt-5.6-luna, low reasoning, Responses | 1/6 | 3/6 | 4/6 |
| Qwen qwen3.8-flash, thinking disabled, Chat Completions | 0/6 | 2/6 | 3/6 |

All 24 planned samples completed with complete token accounting, no missing samples and no grading failures. Correct private candidates are diagnostic only: four correct candidates across the providers were not delivered. Unresolved and failed attempts remain in the denominator.

Limits per attempt were 24 steps, 2,048 output tokens per response, 100,000 cumulative input tokens, 16,000 cumulative output tokens and 300 seconds. No prices were supplied, so no monetary cost is claimed. Provider matrices ran concurrently on one host; latency is not a controlled comparison. Two tasks from one repository do not establish general performance, and no before/after controller ablation was performed.

[Sanitized evidence, source identity, limits and per-sample outcomes](../../benchmarks/baselines/rc14-holdout-2026-09-10.json).

## Observed boundaries

- OpenAI: three work-budget stops on the first task; one accepted delivery and two execution failures on the second. All three second-task private candidates passed independent grading, but only one was delivered.
- Qwen: three work-budget stops overall, one analysis-only completion without a candidate, one agent failure and one input-budget stop. Two correct second-task candidates were not delivered.
- The first-task stops mostly occurred during exploration without a candidate or verification. The second task exercised candidate creation, automatic verification and recovery; recorded verifier failures included normal exit code 1. Sanitized evidence does not retain the exact verifier assertion or command output, so the underlying assertion failure is not established here.
- Code inspection confirms that the closure reserve becomes available when the controller has a pending candidate or is recovering. The evidence motivates investigating exploration-to-candidate progress and verifier recovery; it does not justify weakening approvals or importing a patch that failed verification.

## Validation boundaries

- Local complete checks reached the final release-readiness step after 512 passing tests, strict source/tooling types, docs/contracts, migrations, 7/7 deterministic evaluations, offline benchmarks, both MCP smokes, real Docker execution, installed-package smoke and dependency audit (15 packages, no vulnerabilities, no untrusted lifecycle scripts).
- That final step found a stale requirement for the whole `evaluations` package directory. It was corrected to require the published JSON/JSONL patterns. Tooling typecheck and 15 release-policy/workflow regressions passed after the correction. The branch restriction remains intentional: release checks must finish from clean `main`, not the candidate branch. The full `release:check` command is not reported as passing.
- [CI](https://github.com/Zhivex/zhivex-harness/actions/runs/34492027688) passed all four jobs on the frozen runtime: Ubuntu/macOS tooling and Node 22.13/24 installed consumers. [CodeQL](https://github.com/Zhivex/zhivex-harness/actions/runs/34492027646) passed.
- The local RC14 tarball passed exact content inspection and a separate installation/execution smoke. Its SHA-512 is recorded in the evidence. The holdout executed hash-frozen source, not a protected tag-bound release tarball; neither that local artifact nor RC13's historical certification supplies RC14 publication evidence.
- The repository requires one approving review, code-owner review and all required checks before merging. Those rules were not bypassed.

## Conditions to resume release

1. Reproduce and improve exploration-to-candidate progress and verifier recovery using independent regression fixtures. Treat these two tasks as development data from now on.
2. Freeze the corrected implementation and predeclare a fresh validation cohort and acceptance criteria. Demonstrate accepted deliveries through the problematic paths for both providers, retaining all failures and budget limits; do not tune hidden tests or count undelivered candidates as success.
3. Obtain the required PR approval, merge, pass release checks on clean main, and run protected tag-bound artifact/live/representative certification before publication to `next`.

The statistical comparison is exploratory. The publication hold is based on unresolved delivery behavior in the feature being stabilized, not a claim of general model superiority or a security regression.
