# JSON Schema: low versus default reasoning — 2026-11-14

With identical strict JSON Schema, known-file preload and a 4,096-token response cap, `low` reduced mean latency by **55.5%** and total tokens by **33.2%** in eight paired trials. It avoided the one observed default-effort truncation, but full quality fell from **7/8 to 4/8**: all four low-effort ledger answers contained incorrect expected results in their proposed regression tests. Production defaults remain unchanged.

[Complete evidence](PRELOAD_SCHEMA_EFFORT_2026-11-14.json) contains all sixteen attempts, original synthetic answers, per-call measurements, executable quality scores, failure diagnostics, source hashes and statistical analysis. The preceding [native-schema comparison](PRELOAD_STRUCTURED_OUTPUT_2026-11-14.md) motivated this trial; no historical observations are pooled into its control arm.

## Fixed protocol

Eight pairs comprise four dependency-planner and four transfer-ledger tasks. Each fixture has two default-first and two low-first pairs; order was shuffled before launch with seed 20261120. All workers ran sequentially on Node 22.21.0 using the same frozen runtime, fixtures, schemas and prompts. No tests or builds ran concurrently with live measurement.

Both arms use `gpt-6-luna`, actual governed runtime preload of four known files, native Responses strict JSON Schema and `max_output_tokens: 4096`. Each task has one model request, no model tools after preload, no retries and no response repair. Runtime limits are 8,192 input, 8,192 output and 16,384 total tokens, with the stricter 4,096 per-response ceiling verified on the wire. Fresh workspaces each contain forty historical activity runs. The only treatment change is explicit `reasoningEffort: "low"` versus default, which is omitted on the wire. OpenAI returned `low` and `medium`, respectively, in all calls.

The meter verifies the assigned effort, output cap and exact strict-schema hash before forwarding a request. Each request receives a unique cache key. All sixteen calls reported cached usage explicitly and zero cached input; no unmetered attempts or retries occurred. Input tokens, schema hashes, preload paths and byte counts match within every pair. SDK input/output/total/reasoning/cache usage reconciles with the provider records. This controls measured prompt-cache hits, not server-side schema-compilation caching; balanced order mitigates systematic order effects.

The predeclared aggregate ceiling was **100,000 input-plus-output tokens**, reserving 32,768 before each pair. All eight pairs finished at **57,815 tokens**, stop reason `planned-completion`. Reasoning is already included in output tokens and is not added again. No currency-cost estimate is asserted.

Primary outcomes are output-budget truncation and full executable quality. Secondary outcomes include schema validity, parseability, provider completion, latency and consumption. All failed attempts remain in the comparisons. Exact paired discordance tests govern binary interpretation; continuous 95% intervals use 10,000 paired bootstrap resamples stratified by fixture. These are exploratory estimates from eight pairs across only two synthetic task types, not a broad benchmark or a quality noninferiority test.

Latency measures `runHarnessTask` including preload, model streaming and activity processing. Common initialization/history construction, grading and teardown are excluded. Streaming timestamps are client-observed and may include downstream backpressure.

## Results

| Metric | Default (returned medium) | Low |
| --- | ---: | ---: |
| Attempts / API calls | 8 / 8 | 8 / 8 |
| Provider completed | 7/8 | 8/8 |
| Output-limit truncation | 1/8 | 0/8 |
| Parseable and schema-valid, all attempts | 7/8 | 8/8 |
| Full quality acceptance | 7/8 | 4/8 |
| Answers passing all 11 functional/nonmutation checks | 7/8 | 8/8 |
| Valid regression examples | 21/24 | 18/24 |
| Mean task latency | 24.787 s | 11.040 s |
| Median task latency | 23.922 s | 10.628 s |
| Input tokens | 13,744 | 13,744 |
| Output tokens including reasoning | 20,908 | 9,419 |
| Reasoning tokens, subset of output | 14,745 | 3,261 |
| Non-reasoning output tokens | 6,163 | 6,158 |
| Total tokens | 34,652 | 23,163 |
| Cached input tokens | 0 | 0 |
| Largest observed output | 4,096 | 1,390 |

Low minus default mean latency: **−13.747 s**, 95% bootstrap interval **−16.743 to −11.480 s**. Low was faster in all eight pairs. Mean total tokens decreased by **1,436.125 per task**, interval **−1,740.125 to −1,184.625**, also lower in every pair. The aggregate reduction of 11,489 tokens consists almost entirely of 11,484 fewer reasoning tokens; input is identical and non-reasoning output differs by only five tokens. Reasoning declined by **77.9%**.

Mean time from request start to first text fell from 19.435 to 5.454 s. Model-span time represented 99.74% of task time for default and 99.40% for low. This points to reduced model reasoning as the principal source of the observed speed and consumption differences, rather than faster preload or persistence.

The truncation comparison has one discordant pair (only default truncated), exact two-sided p=1.0. Full quality has three pairs passing only default, four passing both, and one failing both; exact two-sided p=0.25. Therefore the sample does not establish a population-level reduction in truncation or a statistically conclusive quality difference. The observed quality loss is nevertheless material for an adoption decision. Binary bootstrap intervals retained in JSON are descriptive only; exact paired tests govern interpretation, and zero observed truncations does not imply zero underlying risk.

## Quality diagnosis

Quality acceptance requires provider completion, correct preload receipt, strict schema, eleven functional/nonmutation checks, an explanation of 120–160 words and three distinct regression examples whose expected results match the oracle and candidate but differ from the original buggy implementation. Explanation semantics are not independently judged. Native schema constrains structure, not numerical or algorithmic correctness.

All low-effort answers were complete, schema-valid, within the explanation word limit and passed the eleven functional checks. All four planner answers passed full quality in both arms. Every low-effort ledger answer failed full quality because of incorrect regression expectations:

| Pair | Low valid regressions | Diagnosed errors |
| --- | ---: | --- |
| 1 | 1/3 | Expected sender balance 5 instead of 3 after two fee-bearing transfers; tie-order example applies `z` instead of earlier code-unit ID `A`. |
| 3 | 2/3 | Expected sender balance 4 instead of 3 after transfers of 2 and 3, each charging fee 1. |
| 5 | 2/3 | Claims order `A,b` and rejects `a`; correct sequence applies `A,a` and rejects `b` due to remaining balance. |
| 6 | 1/3 | Incorrectly rejects a second affordable transfer; another example accepts a final transfer despite insufficient funds including its fee. |

Six of twelve low-effort ledger regression expectations are wrong. This is not merely a lack of examples that distinguish the original bug: the claimed outputs themselves contradict the source contract and reference execution. The generated replacement code still passes the fixed functional suite; that does not prove correctness for every input or repair the invalid tests.

Default failed only pair 3, ledger: `response.incomplete` with `max_output_tokens`, 4,096 output tokens including 3,216 reasoning and 880 non-reasoning tokens. The 39.538-second answer ends inside the third regression's expected result at `"applied`, leaving invalid JSON. No prefix extraction or repair is counted. SDK task status is `completed` despite the provider-incomplete terminal, so acceptance checks both provider termination and actual output validity.

Exploratory fixture split:

| Fixture | Default / low mean latency | Default / low full quality |
| --- | ---: | ---: |
| Dependency planner | 17.752 / 10.387 s | 4/4 / 4/4 |
| Transfer ledger | 31.823 / 11.693 s | 3/4 / 0/4 |

## Decision and reproduction

Do not change the default based on this result. Low effort is a promising explicit speed/cost option when executable validation can reject wrong expectations, but schema validity alone is not an adequate quality gate. A next bounded experiment could allow one targeted retry after semantic validation fails, or ask the model for test inputs and compute expected outputs with a trusted oracle where one exists. Neither strategy was enabled or measured here.

The new experimental driver is `scripts/benchmark-preload-schema-effort.ts`; analyzer is `scripts/analyze-preload-schema-effort.ts`. Existing schema, meter, fixtures and graders are reused unchanged. No production source or defaults changed in this experiment. The driver requires explicit `--live`, credentials, a fresh output directory and a frozen runtime; rebuilding and launching another campaign incurs new API consumption. See the [benchmark guide](../../benchmarks/README.md).

Offline reanalysis:

```sh
bun scripts/analyze-preload-schema-effort.ts results/preload-schema-effort-2026-11-14/paired-8/campaign.json /tmp/schema-effort-summary.json
```

The linked evidence JSON embeds `campaign` and `analysis`, preserving reanalysis inputs even without ignored local result files. Source and compiled artifact hashes bind the measured implementation. Validation: 11 targeted tests passed with 58 assertions; tooling typecheck, architecture, stable contract and documentation checks passed. These are experiment-focused checks, not a full release certification.
