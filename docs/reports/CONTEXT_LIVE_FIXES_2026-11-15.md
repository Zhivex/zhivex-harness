# Context fixes and real-model validation — 2026-11-15

The two blockers are corrected. In this bounded workload, all 16 A/B attempts
passed exact context and quality checks, and all eight pairs consumed fewer
provider-reported tokens after optimization. Four additional held-out tasks also
passed with the original, tighter budgets. This demonstrates savings for these
fixtures, not universal semantic equivalence or a general latency improvement.

## Changes

1. The harness OpenAI adapter sends complete locally managed Responses history
   with `store:false`. SDK automatic `previous_response_id` continuation previously
   discarded rewritten historical results and refreshed system instructions.
   Explicit `previous_response_id` and `conversation` options now fail closed;
   explicit Chat Completions mode is unchanged. Generate and stream are covered.
   The SDK handles encrypted reasoning replay. The context fingerprint changes
   so older run configurations cannot silently inherit the new behavior.
2. Historical file reads use reversible `line-suffix-v1` encoding of adjacent
   lines sharing long suffixes. Every character survives, including middle facts,
   order, blank lines, CRLF and Unicode. Unsuitable content stays raw. The latest
   exchange stays raw, persisted evidence stays unchanged, and encoding still
   requires trusted durable results and available recovery. Existing non-file
   previews retain their historical/untrusted status. Recovery supports bounded
   exact-substring lookup and pages up to 16,000 characters; host policy and
   current-run/catalog checks continue to apply.

Production token budgets, step limits and compaction thresholds were not raised.

## Paired results

Four before/after pairs per model, alternating AB/BA; no retries or discarded
attempts. The six required fields check the original unpredictable code, arithmetic,
final threshold, inclusive decision rule, scoped `bun-only` policy and amendment
revision. Successful completion also requires the initial four sequential reads,
completed provider responses and matching SDK/wire token accounting.

| Model | Correct before / after | Mean tokens per correct task | Estimated USD per correct task | Token saving | Cost saving | Mean task seconds before / after |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | 4/4 / 4/4 | 25,086.75 → 18,055.75 | $0.002584875 → $0.001891775 | 28.03% | 26.81% | 9.022 → 7.940 |
| gpt-6.1-sol | 4/4 / 4/4 | 24,203.25 → 16,757.75 | $0.049762500 → $0.034827500 | 30.76% | 30.01% | 8.887 → 8.846 |

All 85 requests used full-history transport, with no server-side continuation.
The optimized arm carried lossless encodings in 25 requests. Reported cache hits
were zero. No task compacted. Luna's fourth optimized task made one rejected
recovery call (and one rejected discovery call); their tokens and latency remain
in the totals. It subsequently returned every required field correctly. Failed
calls were not converted into successful evidence or permission.

Latency: Luna was faster in 3/4 pairs; Sol in 1/4. The paired bootstrap 95% interval
for mean time saved was [0.025, 1.802] seconds for Luna and [-0.528, 0.811] for Sol.
With four pairs, these intervals are descriptive. **A general Sol speedup is not
established.** Token and cost savings are the supported efficiency result.

Cost per correct task = total cost of **all** attempts in that arm / number of
correct completed tasks. Failed tasks would remain in the numerator. Missing
usage or zero correct tasks produces no finite cost-per-success estimate.
USD uses [OpenAI Standard short-context pricing](https://developers.openai.com/api/docs/pricing),
checked 2026-11-15: Luna input/output/cached $0.10/$0.50/$0.01 and Sol
$2.00/$10.00/$0.10 per million tokens. Reasoning is already included in output.
These are public-rate estimates, not invoices or account-specific discounts.

## Controls and limits

The control restores the four pre-optimization context modules from `f7af7993`
within the same migrated checkout. **Both arms include the full-history provider
fix**, so the comparison isolates context efficiency against a functioning
baseline. Neither caller supplies `store:false`: the production adapter must
supply it, and the HTTP meter asserts it. The defective server-continuation runs
remain in the [earlier report](CONTEXT_LIVE_VALIDATION_2026-11-15.md).

Both arms receive identical finite limits: 120,000 input, 8,000 output, 128,000
total tokens; 8 steps; 2,048 output tokens/request; low reasoning; 40,000 estimated
compaction threshold. These experimental limits permit a correct raw-history
control instead of the previous early budget-closure behavior. A fixed 600,000
campaign ceiling reserved the maximum remaining pair before starting it. The
campaign finished all eight planned pairs at 336,414 tokens ($0.3562666 estimated).

A separate prespecified follow-up used held-out repetition 2, both models and both
fixtures, with the **original 52,000 input / 8,000 output / 60,000 total budget and
14,000 compaction threshold**. All four optimized tasks passed, without compaction:
18,271 and 17,721 tokens for Luna; 16,755 and 16,755 for Sol. Total 69,502 tokens,
$0.0734204 estimated. These after-only results are not mixed into the A/B denominator.

The workloads intentionally contain repetitive logs with unique facts in the
middle; they do not establish savings on arbitrary source code or incompressible
text. Round-trip tests cover those cases and the raw fallback. The original
offline short-line workload now saves **0%** message tokens because safe fallback
replaces lossy excerpts. Its result-index median improves 1.57× and scoped refresh
4.78× in this run; timing is environment-dependent. Earlier 61.1% excerpt savings
are historical and must not be attributed to the corrected algorithm.

No paid attempts from this fix cycle were discarded: 20 tasks, 405,916 tokens,
$0.4296870 estimated. The cumulative ledger also retains all 26 earlier attempts
and their failures: one earlier receipt remains unknown. Their different
configurations are kept separate from the current cost-per-success comparison.

## Evidence and reproduction

- [A/B campaign and raw task records](evidence/context-live-fixed-2026-11-15/campaign.json)
- [Cost, quality and paired latency summary](evidence/context-live-fixed-2026-11-15/cost-summary.json)
- [Held-out original-budget validation](evidence/context-live-fixed-budget-2026-11-15/validation.json)
- [All-campaign consumption ledger](evidence/context-live-fixed-2026-11-15/cumulative-ledger.json)
- [Bundle manifest](evidence/context-live-fixed-2026-11-15/runtime-manifest.json), [source bindings](evidence/context-live-fixed-2026-11-15/source-bindings.json) and adjacent source/control snapshots
- [Offline fallback and cache/scoped benchmarks](evidence/context-live-fixed-2026-11-15/offline.json)

```sh
bun scripts/benchmarks/context-live/freeze.ts /tmp/context-fixed-new
bun --env-file=.env scripts/benchmark-context-live-fixed.ts --live --runtimes /tmp/context-fixed-new --directory /tmp/context-fixed-evidence-new
bun scripts/analyze-context-live-cost.ts /tmp/context-fixed-evidence-new/campaign.json /tmp/context-fixed-evidence-new/cost-summary.json
bun --env-file=.env scripts/validate-context-live-fixed-budget.ts --live --runtime /tmp/context-fixed-new/after.mjs --directory /tmp/context-fixed-budget-new
bun scripts/benchmark-context-efficiency.ts --assert-improvement
```

Live commands incur provider charges; directories must be new so earlier failures
cannot be overwritten. Source snapshots and bundle hashes bind this run to its
checkout; a later `HEAD` or dependency installation defines a new comparison.

## Local validation

Bun 1.4.3. `bun run test`: **2,720 passed, 1 skipped, 0 failed** across 364
files (267.60 seconds). Subsequent focused checks, including two additional
query/mixed-batch regressions: **30 passed, 0 failed** across five files.
`bun run typecheck`, `bun run typecheck:tooling`, `bun run architecture:check`,
`bun run docs:check` and `git diff --check` passed. Existing approval, scope,
checkpoint, symlink and mutation-policy regressions remain covered by the suite.
This is local repository validation, not a new published-package certification.
