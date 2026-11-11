# GA-01: correction and validation

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

**GA-01 resolved in the local checkout. GA remains pending.**

The SDK calculated the output maximum once at invocation start and
reused it for each turn's preflight. After consuming 2 tokens, it reserved
30,000 again despite only 29,998 remaining; Meta and OpenAI failed before the
second call. Core 1.20.0 still exhibits this combination.

Harness preserves durable guardrails and calculates the transport maximum
per call using observed usage and persisted checkpoints. Observed
usage covers turns not yet present in the store; resume incorporates
the checkpoint without double counting. A smaller explicit maximum is preserved.
Responses exceeding limits are rejected before executing their tools.
Qwen and the subagent path retain their existing transport policy.
Limits still depend on provider-reported usage; this change
does not turn estimates into a billing guarantee.

Validation performed:

- Original reproduction: Meta, OpenAI and Qwen complete two turns.
- Seven regressions: decreasing maximum, exhaustion, explicit maximum,
  resume with approval and no tool execution when tokens are exceeded.
- `bun run check`: exit 0; 527 tests, documentation, contracts, types,
  migrations, evaluations, benchmarks, MCP, Docker and installed package.
- Live approval/restart: Meta `muse-spark-1.2`, OpenAI `gpt-5.6-luna` and Qwen
  `qwen3.8-max` pass, with one execution and journal entry.
- Live OCI: all three providers pass command, inspection, approval and
  verified import to the host.

The [structured evidence](evidence/ga-budget-remediation-2026-09-19.json)
includes hashes and bounds the validation sequence relative to the latest
adjustments. It is not evidence of a protected release or publication.

Pending: improve and reproduce repair delivery described in
[the RC14 holdout](RC14_VALIDATION_2026-09-10.md), freeze a new cohort,
complete the representative matrix and collect CI, review and release gates
on an immutable candidate. Those approval criteria were not modified.
