# Native JSON Schema with known-file preload — 2026-11-14

Strict native JSON Schema was accepted by OpenAI and the installed SDK, but this small paired trial did not establish a quality or latency improvement. Prompt-only JSON passed 8/8 tasks; native schema passed 7/8, with one output-budget truncation. All completed responses in both arms met the schema and executable quality checks. No production defaults changed.

[Complete evidence](PRELOAD_STRUCTURED_OUTPUT_2026-11-14.json) retains every attempt, synthetic answer, per-call usage, telemetry, source hashes and analysis. The earlier [cap comparison](PRELOAD_CAP_AB_2026-11-14.md) and [one-retry replay](PRELOAD_RETRY_ONCE_2026-11-14.md) motivated this experiment; they are not controls for this trial.

## Protocol

- Eight pairs: four dependency-planner repairs and four transfer-ledger repairs, two schema-first and two prompt-first pairs per fixture, shuffled with seed 20261119. Workers run sequentially on Node 22.21.0 against one frozen runtime.
- Both arms: `gpt-6-luna`, known-file runtime preload of the same four files, identical prompts, default reasoning (omitted on the wire, returned `medium`), one request, `max_output_tokens: 4096`, no model tool calls, retries or response repair. Forty historical activity runs per fresh workspace.
- Treatment only: native Responses `text.format: { type: "json_schema", name: "repository_repair", strict: true, schema }`, passed through existing `providerOptions`. The control requests JSON in the prompt without a native format. The meter checks format and exact schema hash before networking; offline transport tests verify the installed SDK preserves the schema.
- Schemas use strict required objects for replacement, explanation and regression examples. Both prompts require planner jobs to include `disabled`; ledger regression examples use exactly accounts a/b/c and integer sequence/fee values. These same-for-both-arm constraints differ from historical prompts, so historical cohorts are not pooled. Replacement ledger functions must still support arbitrary accounts under the source contract.
- Primary endpoint: schema-valid, provider-completed output across all attempts. Secondary endpoints: parseability, full executable quality, truncation, wall time and tokens. Exact paired discordance tests govern binary conclusions. Continuous intervals use 10,000 paired bootstrap resamples stratified by fixture; all failed attempts remain included.
- Fresh cache key per request, sixteen unique hashed keys, explicit cached-usage reporting and zero cached input in all calls. No warm-cache cohort was run. This does not measure or control server-side schema compilation caches.
- Budget: 100,000 input-plus-output tokens; reserve 32,768 before each pair; maximum 16,384 per task. Stop on missing usage or failed cache control. Completed all sixteen requests at **67,769 tokens**, with no unpaired tasks or unmetered calls. Reasoning is already included in output and must not be added again. No currency-cost estimate is asserted.

Wall time starts before `runHarnessTask`, includes preload, model and activity handling, and ends after the task resolves. Fixture setup, common runtime initialization/history, grading and teardown are excluded. Client-observed streaming timestamps may include backpressure. No concurrent local tests/builds ran during measurement.

## Results

| Metric | Prompt JSON | Native strict schema |
| --- | ---: | ---: |
| Attempts / API calls | 8 / 8 | 8 / 8 |
| Provider completed | 8/8 | 7/8 |
| Parseable and schema-valid, all attempts | 8/8 | 7/8 |
| Full quality acceptance | 8/8 | 7/8 |
| Functional contract checks passed | 88/88 | 77/88 |
| Valid regression examples | 24/24 | 21/24 |
| Output-limit truncations | 0/8 | 1/8 |
| Mean task latency | 25.674 s | 25.984 s |
| Median task latency | 24.241 s | 23.600 s |
| Input tokens | 12,272 | 13,744 |
| Output tokens, including reasoning | 21,496 | 20,257 |
| Reasoning tokens, subset of output | 15,710 | 15,160 |
| Total tokens | 33,768 | 34,001 |
| Cached input tokens | 0 | 0 |

Schema minus prompt mean latency was **+0.309 s (+1.2%)**, bootstrap 95% interval **−1.549 to +2.331 s**. Mean total tokens differed by **+29.125 per task (+0.69%)**, interval **−182.5 to +254.875**. Input increased by 184 tokens/task on average (+12.0%); output decreased in aggregate. Schema overhead is part of the treatment, not normalized away.

Schema validity and full quality each had seven pairs passing both arms and one passing only prompt; exact paired two-sided p=1.0. This is insufficient evidence of either superiority or harm. Binary bootstrap intervals in the JSON are descriptive only; an all-success control sample does not imply a zero underlying failure rate.

Exploratory fixture split: planner mean latency fell from 19.703 to 17.365 s, with 4/4 quality in both arms. Ledger rose from 31.646 to 34.603 s, with quality 4/4 versus 3/4. Four pairs per fixture are too few for broad performance claims. Model-span time represents approximately 99.71% of aggregate measured task time.

## Remaining failure

Pair 5, schema arm, transfer-ledger: HTTP 200 followed by `response.incomplete`, reason `max_output_tokens`. It consumed 1,818 input and 4,096 output tokens, including **4,043 reasoning tokens**, leaving only 53 non-reasoning output tokens. The saved answer stops inside the function declaration at `configurable`; it is a JSON prefix, not an accepted complete document. First text arrived at approximately 42.274 s after request start; total task time was 42.941 s.

This is an exhaustion failure, not a completed response violating its schema. All seven schema responses that actually completed were valid and passed the code checks. All eight prompt controls also passed, so the historical malformed-JSON failure did not recur in this sample and this experiment cannot quantify how often schema prevents it. The SDK task status still says `completed` for the truncated response; acceptance therefore checks the provider terminal event as well as the parsed output and functional grader.

Quality checks cover strict shape, 120–160 explanation words, eleven executable contract/nonmutation cases and three distinct regression examples that fail the original implementation and pass the replacement. Schema alone does not enforce algorithm correctness, exact example count or explanation word count; explanation semantics are not independently judged. Truncated code is rejected rather than executed as if complete.

## Implementation and decision

The opt-in experiment lives in `scripts/benchmark-preload-structured.ts`, with strict schemas in `scripts/benchmarks/preload-output-schema.ts` and analysis in `scripts/analyze-preload-structured.ts`. The shared experimental meter adds optional wire-format/schema-hash assertions while preserving its existing defaults. Existing production preload permissions and workspace boundaries are unchanged.

Keep native schema as an explicit experimental choice for callers needing a typed response contract. These results do not justify enabling it by default or claiming a latency improvement. Continue to reject provider-incomplete responses before parsing/acceptance. A next bounded experiment could test schema plus reduced reasoning effort or a separately capped recovery specifically on exhaustion; neither was enabled here.

Validation: 11 targeted tests passed (58 assertions), tooling typecheck, architecture and stable contract checks passed. Offline tests cover schema strictness, malformed JSON, separation of structural versus functional quality, actual SDK transport and rejection of mismatched formats before network access.

To reanalyze without API consumption:

```sh
bun scripts/analyze-preload-structured.ts results/preload-structured-2026-11-14/paired-8/campaign.json /tmp/preload-structured-summary.json
```

The linked evidence JSON also embeds the complete campaign and summary for durable reanalysis if local ignored result files are unavailable.
