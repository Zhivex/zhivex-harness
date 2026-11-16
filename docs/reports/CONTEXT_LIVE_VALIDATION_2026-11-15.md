# Live context-efficiency validation — 2026-11-15

**Verdict: not certified as a quality-preserving production improvement.** Real
OpenAI calls exposed a transport mismatch that the mock tests did not cover.
Stateless calls reduce reported token consumption in the bounded stress workload,
but neither variant completes that workload within its eight-step allowance.
There is no demonstrated quality-preserving end-to-end speedup from these runs.
No production runtime or provider defaults were changed during this validation.

## Frozen comparison and accounting

Both variants use the same current migrated workspace and installed dependencies.
The control restores the four pre-optimization context modules from commit
`f7af7993` and reverts only the corresponding harness wiring and recovery-denial
metadata. It does not replace the entire current workspace with an older release.
The optimized variant is the implementation tested in the offline report.
All recorded runtime hashes match the [freeze manifest](evidence/context-live-runtime-manifest-2026-11-15.json).

All campaigns ran under Bun 1.4.3 against `api.openai.com`, using `gpt-6-luna` and
`gpt-6.1-sol`, low reasoning, streaming Responses and sequential paired tasks.
The server returned those same model names. Unique cache-routing keys were sent
on every call; the recorded cached-input counts in the stateless comparisons are
zero. This is observed usage, not a guarantee that cache keys always prevent hits.

The [combined ledger](evidence/context-live-ledger-2026-11-15.json) contains
**26 task attempts, 165 requests and 706,509 reported tokens**. One initial request
has unknown usage after the instrumentation rejected an oversized SSE line; the
706,509 figure is therefore a known subtotal, not the exact billed total. The run
stopped on that unknown receipt. A conservative additional 60,000-token planning
reserve was retained for that attempt; known usage plus this reserve is 766,509,
below the announced 800,000-token campaign allowance. The reserve is not a provider
receipt or a billing claim. No failed attempt was retried or removed from records.

## 1. Default Responses continuation: projection is not transmitted

[Original campaign](evidence/context-live-2026-11-15/campaign.json), 14 attempts.

The installed `@zhivex-ai/openai` adapter uses the most recent `responseId` as
`previous_response_id` and serializes only messages after that response. This
omits both projected old results and newly prepended scoped guidance. The server
continues using its previous history. All initial live request captures reported
zero historical projections even in the optimized arm.

This is reproduced without network access in
`tests/context-live-benchmark.test.ts`, using the installed OpenAI serializer:
normal continuation omits changed historical context and prepended instructions;
`store:false` includes both. The current harness OpenAI wrapper selects envelope
format but does not disable this continuation path.

Consequences:

- Local compaction measures shortened history while the server can still retain
  the original history. The offline token reduction is not evidence of an equal
  production reduction under default Responses continuation.
- Refreshed scoped guidance may not reach the model on subsequent turns. In the
  diagnostic fixture, Luna returned the business rule in the `policy` field
  instead of the required `bun-only` instruction. Sol recovered that instruction
  through additional explicit reads in its completed attempts.
- Retaining durable originals establishes recoverability, but does not establish
  that the actual provider context matches the harness's projected context.

The initial correction fixture also contained an **incorrect expected decision**:
its written `total <= threshold` rule required `release`, while its v1 oracle
expected `hold`. This was a benchmark defect, not a model error. Raw answers and
original grades are preserved; a separate [oracle audit](evidence/context-live-2026-11-15/oracle-audit.json)
corrects only that expectation. Five of fourteen attempts meet the corrected exact
field criteria; policy failures and the missing response remain failures. This
initial campaign is diagnostic and is not used to certify quality or savings.
The revised fixture derives its expected decision from the written inequality and
has an independent regression assertion for both the hold and equality cases.

## 2. Stateless middle-context stress: fewer tokens, no successful completion

[Campaign](evidence/context-live-stateless-2026-11-15/campaign.json) ·
[Summary](evidence/context-live-stateless-2026-11-15/summary.json).

Four matched pairs, one pair per model and fixture, with opposite AB/BA ordering
across fixtures. Both variants explicitly use `store:false`; this is a separate
configuration, not an unnoticed production fix. Three large files place required
facts in their middles, followed by a short superseding amendment. Project guidance
provides a sixth independently checked field. Initial reads must occur in order,
one per tool turn. Both arms have eight steps, 2,048 output tokens per request,
52,000 cumulative input tokens and 60,000 total tokens per task. Compaction remains
active with identical configured thresholds. All recovery calls count toward cost
and latency.

| Model | Total tokens before → after | Input tokens before → after | Mean task latency before → after | Exact correct before / after |
| --- | ---: | ---: | ---: | ---: |
| gpt-6-luna | 61,585 → 55,099 (−10.5%) | 60,793 → 54,001 | 14.10 s → 13.39 s | 0/2 / 0/2 |
| gpt-6.1-sol | 64,102 → 57,097 (−10.9%) | 63,606 → 56,414 | 15.07 s → 15.24 s | 0/2 / 0/2 |

Each total sums both fixtures for that model. Output totals are 792 → 1,098 for
Luna and 496 → 683 for Sol. Both variants exhausted their step allowances without
producing a final answer. Optimized requests actually transmitted projections
(nine requests for Luna, ten for Sol) and retained scoped guidance. They made five
and six recovery-tool calls respectively. Compactions fell from five to two for
Luna and four to two for Sol, but recovery and further compaction still prevented
successful delivery under the fixed allowance.

All eight task usage totals agree between the SDK and wire receipts. These are
measured savings for **unsuccessful bounded attempts**, not savings per successful
task. Both baselines also fail: this does not prove that the optimization alone
caused a regression. It demonstrates that recoverable storage is insufficient to
claim useful context continuity within the tested operational limits. With only
two pairs per model, bootstrap intervals are descriptive and do not support broad
latency conclusions. Local context-preparation totals did not consistently improve
in these small live runs; the prior 64-scope microbenchmark is not an end-to-end
latency claim.

## 3. Separate leading-context control: budget-confounded, not acceptance evidence

[Campaign](evidence/context-live-control-2026-11-15/campaign.json) ·
[Summary](evidence/context-live-control-2026-11-15/summary.json).

Two additional pairs used leading facts that fit preserved previews, three initial
reads, `store:false`, and compaction disabled equally. This was a diagnostic positive
control, not a replacement for the failed stress test. Its 16,000 input / 20,000
total-token limits interacted with the harness's closure reserve: both variants
returned partial JSON before reading the third file. All four exact-quality checks
fail. Runtime `completed` status did not mean the task was solved.

| Model | Tokens before → after | Task latency before → after | Exact correct |
| --- | ---: | ---: | ---: |
| gpt-6-luna | 8,318 → 7,808 | 5.57 s → 6.79 s | 0/1 in both |
| gpt-6.1-sol | 8,073 → 9,911 | 6.25 s → 8.99 s | 0/1 in both |

This control is budget-confounded and provides no successful-task quality or
speedup evidence. Its entire 34,110-token consumption remains in the ledger.
No additional paid retries were used to seek a favorable result.

## Required work before certification

1. Align OpenAI transport history with the harness's projected messages and
   refreshed guidance. Explicit stateless mode establishes that alignment in
   these experiments; a production change must also cover reasoning replay,
   approvals, resume and provider-specific continuation behavior.
2. Reconcile compaction, recovery pagination and closure reserves so omitted
   facts can be recovered and used before the step/token budget closes the task.
3. Repeat a preregistered paired campaign with an independently verified oracle
   and a completion-capable baseline. Require exact quality and successful task
   delivery before interpreting reduced consumption as an efficiency improvement.

## Reproduction and local checks

The scripts intentionally require explicit live opt-in; the following commands
incur new provider usage. Use fresh output directories. Freeze manifests bind the
specific workspace used for a campaign; newer checkouts are new experiments.

```sh
bun run scripts/benchmarks/context-live/freeze.ts /tmp/context-runtime-new
bun --env-file=.env run scripts/benchmark-context-live.ts --live \
  --runtimes /tmp/context-runtime-new --directory /tmp/context-default-new
bun --env-file=.env run scripts/benchmark-context-live.ts --live --stateless \
  --runtimes /tmp/context-runtime-new --directory /tmp/context-stateless-new
bun run scripts/analyze-context-live.ts /tmp/context-stateless-new/campaign.json /tmp/context-summary.json
```

Historical driver snapshots are retained alongside the campaigns. The archived
v1 fixture is deliberately not rewritten to hide the oracle defect. The current
script uses the corrected fixture. Offline validation passed 24 tests across the
live benchmark, context-efficiency and request-projection suites (158 assertions).
Type checking also passed. The installed-SDK serialization regression requires no
credentials and makes no network requests. Existing offline runtime validation is
not a substitute for the negative live certification result above.
