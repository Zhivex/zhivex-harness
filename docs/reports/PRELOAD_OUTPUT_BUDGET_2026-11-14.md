# Preload output budget and cache-controlled OpenAI comparison

The experiment increased the response output ceiling from **2,048 to 4,096 tokens** for both ordinary reads and explicit preload. Production defaults, reasoning effort and automatic preload behavior remain unchanged. All 16 new tasks passed quality checks and all 24 responses completed with zero reported cache reads. Preload saved **17.8% of total reported tokens**; total latency improvement remains inconclusive.

[Full evidence](PRELOAD_OUTPUT_BUDGET_2026-11-14.json) retains the previous failed response, all new attempts and synthetic answers, per-call cache/usage records, protocol, bootstrap summaries and artifact/source hashes. Frozen live bundles are local under `results/preload-output-budget-2026-11-14/`.

## What exhausted the previous budget

In pair 2 of the earlier repository follow-up, the preload pagination response used **2,048 output tokens, all 2,048 classified as reasoning**, and ended `response.incomplete` without visible text. It had 1,378 input tokens, zero cached input tokens and about 23.74 seconds from fetch start to terminal SSE. The SDK still labelled the task completed; quality correctly failed. This was not a file-reader failure or missing context: all selected files had been loaded.

The measured failure is consistent with the response ceiling being reached before code/text generation. The original meter did not retain `incomplete_details.reason`, so that historical field cannot be reconstructed; the new meter records it. A response ceiling must accommodate reasoning and the delivered answer. Successful earlier preload answers needed roughly 226–269 non-reasoning tokens in addition to reasoning; reserving only 2,048 for everything left no headroom for that outlier. The unfinished response gives a lower bound on its reasoning demand, not an estimate of how much more it needed.

The experimental adjustment doubles `maxTokens` to 4,096, with task limits of 8,192 input, 8,192 output and 16,384 total tokens. This leaves room for the control's tool-request response plus a full final response. All wire requests are checked against the assigned 4,096 ceiling. Default reasoning remains omitted and OpenAI returned `medium` throughout. No retry-on-truncation was introduced.

**Important limitation:** every response in this new campaign used fewer than 2,048 output tokens (maximum 1,584 control; 1,700 preload). Therefore this campaign did not observe the additional headroom being used. Zero new truncations is encouraging but does not prove that raising the ceiling fixed the previous stochastic failure, or that 4,096 guarantees completion. The earlier failing inference cannot be replayed exactly. This is a new tool-versus-preload comparison at a larger ceiling, not a randomized 2,048-versus-4,096 causal test.

## Cache and consumption controls

The earlier cohort had 4,136 cached input tokens only in preload, confounding the comparison. This campaign assigns a fresh random `prompt_cache_key` to **every HTTP request**, including the control's second call. It does not change the prompt, file content, tools or reasoning setting. Only a hash of the key is retained in the measurement record. OpenAI documents these keys as separating cache reuse between request groups; this protocol then verifies actual usage rather than assuming a cache miss. See the [official caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

All **24 key hashes were distinct**, every response explicitly reported cached-token usage, and **cached input tokens were zero in both variants**. The predetermined stopping rule would retain the offending record and stop on missing/nonzero cached usage. There were no cache warmups or paid judging calls. This measures a deliberately cold-cache workload, including the control's within-task follow-up; it does not predict performance when a production application reuses cached prefixes. Zero reported cache reads also does not measure every hidden provider-internal optimization.

Plan: eight paired tasks, four invoice and four pagination pairs, balanced first/second position within fixture and shuffled before execution. Same synthetic repositories and executable graders as the [implementation campaign](KNOWN_FILE_PRELOAD_2026-11-14.md). Both variants use the same frozen runtime and available tools, Node v22.21.0, `gpt-6-luna`, the same prompt wording apart from the context route, and 40 activity-history runs. Total time includes the runtime preload; common initialization/history seeding and teardown are excluded. Builds and tests ran outside live measurement.

Budget: **90,000 aggregate reported tokens**, with 32,768 reserved before each pair. Existing response/request-count guards, per-task caps, timeouts and no-retry rule remain. The full plan completed using **45,858 tokens (51.0% of budget)**. All 24 provider usage records reconcile with the 16 SDK task totals. No tasks were excluded, retried or replaced. This is the new campaign's consumption, separate from the 37,478 tokens spent on the previous implementation validation. No dollar cost or cache-write billing estimate is claimed.

## Results

| Metric | Ordinary tool read | Explicit preload |
| --- | ---: | ---: |
| Mean total latency | 12.85 s | 12.49 s |
| Median total latency | 11.44 s | 11.09 s |
| Mean first text to host | 10.85 s | 10.48 s |
| Model requests | 16 | 8 |
| Input tokens | 15,756 | 11,068 |
| Output tokens, including reasoning | 9,407 | 9,627 |
| Reasoning tokens, subset of output | 6,717 | 7,602 |
| Total tokens | 25,163 | 20,695 |
| Cached input tokens | 0 | 0 |
| Provider-complete tasks | 8/8 | 8/8 |
| Full quality passes | 8/8 | 8/8 |
| Executable contract/nonmutation checks | 56/56 | 56/56 |

Mean total latency reduction: **355 ms / 2.8%**, 95% paired bootstrap interval **−993 to +2,149 ms**. Preload was faster in four of eight pairs. The primary endpoint includes all measured pairs, regardless of quality; the interval uses 10,000 paired resamples stratified by fixture. First-text and fixture-specific comparisons are also inconclusive. This is not evidence that latencies are equivalent.

Preload used fewer total tokens in all eight pairs: mean saving **558.5 tokens/task**, interval **379.75–744.25**. The total reduction is **17.8%**; input fell 29.8%, while output rose 2.3% and reasoning rose 13.2%. Reducing the number of calls saved input processing but did not reduce reasoning in this sample. The larger ceiling is not a fixed token charge: actual output use stayed well below it.

All candidates met exact JSON format, explanation length, repository contract tests and input immutability checks. These remain two small synthetic multi-file repair/review tasks, not independent human quality assessment or full repository-edit execution. Eight successful preload tasks do not establish a negligible truncation probability or general coding-quality equivalence.

## Latency interpretation

The control's initial model call to request files averaged **1.98 s**. Its final answer call averaged **10.65 s**, versus **12.38 s** for preload's single answer call. Thus most of the removed first-call time was offset by a longer final call in this sample. The exploratory interval for that final-call difference crosses zero. The evidence does not isolate whether reasoning variability, scheduling, network or other provider behavior caused the offset.

Call times are client-observed streaming intervals and include downstream consumption/backpressure. Persistence callbacks overlap them and must not be added again. The final answer call remains the dominant latency contributor; local read time was approximately 3.89 ms for the control and 2.20 ms for the host preload.

## Validation and decision

The meter now supports an explicitly selected 4,096 experimental ceiling, optional per-request cache isolation, a flag distinguishing reported cache usage from missing usage, and the provider's incomplete reason when present. Its existing defaults remain 1,024 tokens and no cache isolation. A regression test verifies unique keys, unchanged prompt content and exhaustion metadata. The new dedicated benchmark/analyzer preserve earlier scripts and frozen cohorts.

Focused meter/grader/statistics tests, tooling typecheck, architecture and stable-contract checks passed. Independent arithmetic reconciliation verified task counts, all 24 unique keys, zero reported cache reads, the 45,858-token ledger, means and all functional cases.

Keep production defaults unchanged. For this experiment, 4,096 is a reasonable explicit safety margin, but not a demonstrated universal fix. Preserve provider completion/quality checks independently of the SDK task status. The current evidence supports token savings from known-file preload; it does not support promising lower total latency or enabling preload automatically. No additional paid calls were made after completing the fixed plan.
