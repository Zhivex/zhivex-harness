# Direct 2,048 versus 4,096 output-token comparison with preload

With preload in both arms and zero reported cache reads, **2,048 output tokens truncated 6/8 responses; 4,096 truncated 0/8**. Seven of eight responses in the larger-ceiling arm actually exceeded 2,048 tokens. Full quality passes were **1/8 versus 6/8**, at the cost of higher observed time and consumption. Production defaults remain unchanged.

[Complete evidence](PRELOAD_CAP_AB_2026-11-14.json) preserves every attempt and synthetic answer, per-call usage, declared protocol, paired analysis, failure classification, and runtime/worker/source hashes. Immutable live bundles and raw results remain locally in `results/preload-cap-ab-2026-11-14/`.

## Controlled design

Eight fixed pairs, four per fixture, with each cap running first twice within each fixture. The balanced plan was shuffled before execution. Every task used the implemented runtime preload, the same model (`gpt-6-luna`), default/omitted reasoning (`medium` returned), task prompt, source files, available tool catalog and runtime bundle. Tools were disabled for model selection after the host preload, so each task made exactly one model request. The only assigned generation parameter that varied was `maxTokens` / wire `max_output_tokens`: 2,048 or 4,096. Per-task input/output/total budget ceilings and timeout were identical in both arms.

Each request received a unique cache key using the previously validated experimental transport control. All **16 requests explicitly reported zero cached input tokens**, all key hashes were distinct, and input-token usage was identical within every pair (11,756 input tokens per arm overall). No cache warmups or paid judging calls were used. This is a cold-cache experiment, not a prediction for cached production traffic.

Primary endpoints were provider-confirmed output-cap truncation and all-criteria quality, with exact paired discordance tests. Secondary endpoints were total wall latency and actual tokens across **all attempts**, including truncations and quality failures, using 10,000 paired bootstrap resamples stratified by fixture. No quality-based exclusions, retries, replacement attempts, significance stopping or post-result task changes were allowed.

Total time includes host preload, model streaming and synchronous activity callbacks. Shared initialization/history seeding, teardown and local grading after the result are excluded. Each isolated worker used Node v22.21.0 and 40 prior activity runs. Tests/builds ran outside the live window.

## Harder repository tasks

Each synthetic repository contained implementation, contract, example, example test and scoped `AGENTS.md`. The model received four selected file snapshots and normal scoped guidance. It had to return a complete JSON object with a replacement pure function, a 120–160-word explanation and **three distinct regression examples with expected outputs**, each detecting a defect in the original implementation.

- **Dependency planner:** simultaneous topological rounds, code-unit ordering, disabled/missing dependency propagation, duplicate dependencies, self/multi-node cycles and their dependents, independent components and no input mutation. Eleven held-out functional cases include a reversed 18-node chain.
- **Transfer ledger:** deduplicate before ordering and retain the first occurrence even if rejected; sequence/ID tie ordering; fee accounting; unknown/self transfers; invalid amounts; insufficient funds; atomic rejections; nested input immutability. Eleven held-out cases exercise interactions between these rules.

Candidates were executed in fresh bounded VM contexts with no host objects, disabled string/Wasm code generation and 100 ms per evaluation. These fixtures are pure functions; the evaluator is not a general untrusted-code sandbox. Reference tests checked oracle examples, acceptance of complete reference fixes, rejection of original defects, truncated JSON and duplicate regression examples. Explanation length is checked, but explanation semantics are not independently judged. These are demanding synthetic multi-file repair proposals, not full real-repository edit/build/deployment acceptance.

## Results

| Metric | Cap 2,048 | Cap 4,096 |
| --- | ---: | ---: |
| Attempts / model requests | 8 | 8 |
| Provider-complete responses | 2/8 | 8/8 |
| `response.incomplete`, reason `max_output_tokens` | **6/8** | **0/8** |
| Full quality passes | **1/8** | **6/8** |
| Responses using more than 2,048 output tokens | 0 | 7 |
| Maximum observed output tokens | 2,048 | 3,138 |
| Mean total wall latency | 20.98 s | 24.52 s |
| Median total wall latency | 20.62 s | 26.05 s |
| Input tokens | 11,756 | 11,756 |
| Output tokens including reasoning | 16,014 | 20,066 |
| Reasoning tokens, subset of output | 12,417 | 14,647 |
| Total tokens | 27,770 | 31,822 |
| Cached input tokens | 0 | 0 |

The larger ceiling increased mean time by **3.54 s (+16.9%)**, paired bootstrap 95% interval **+1.28 to +5.81 s**, and mean consumption by **506.5 tokens/task (+14.6% total)**, interval **+260.1 to +744.9 tokens/task**. Latency here means time until the attempt ended, not time until a valid repair was obtained. The smaller ceiling often stops early without delivering usable JSON, so its lower time is not evidence of a better user outcome. No retry strategy or expected time-to-eventual-success is estimated.

Unlike the previous [4,096-cap follow-up](PRELOAD_OUTPUT_BUDGET_2026-11-14.md), this direct comparison genuinely exercised the extra headroom: seven completed larger-cap responses used 2,077–3,138 output tokens. The assigned output cap materially affected what the model could deliver in this workload. This does not guarantee a 4,096 ceiling will avoid truncation on other tasks or reproduce the same answer a smaller-cap inference would have generated.

## Quality failures and paired uncertainty

At 2,048, six answers ended explicitly because of the output cap. Of the other two, one passed everything; the other returned a raw function rather than the required JSON, explanation and regression tests. It is a format/delivery failure, not evidence that its raw function is necessarily incorrect.

At 4,096, all responses reached `response.completed`. Six passed every criterion. One planner forgot to exclude already-completed jobs from subsequent ready sets, repeatedly scheduling them and exceeding the evaluator timeout on ten of eleven functional cases. Another response had trailing malformed JSON despite containing a plausible replacement function. A larger budget cannot eliminate logical or formatting errors.

By fixture, planner quality was 1/4 versus 2/4; ledger quality was 0/4 versus 4/4. Both fixtures had three smaller-cap truncations and zero larger-cap truncations. These subsets are descriptive, not independent general quality estimates.

For truncation, six pairs favored 4,096 and none favored 2,048: nominal exact two-sided paired p = **0.03125**. For full quality, six pairs favored 4,096, one favored 2,048 and one failed in both: p = **0.125**. With two primary endpoints, Holm-adjusted p values are **0.0625 and 0.125**; neither passes a family-wise 5% threshold. Eight pairs give limited inferential power. The observations support further use of the larger ceiling for this workload, but should not be presented as a broadly established quality effect. Binary bootstrap intervals in the machine-readable exploratory output are unstable at this sample size; the exact paired tests govern the primary interpretation.

## Consumption and validation

Predeclared aggregate ceiling: **100,000 tokens**. A conservative **32,768-token reservation per pair** covered the identical task budgets (8,192 input, 8,192 cumulative output, 16,384 total each). Each request was additionally bounded to its assigned cap and only one request was permitted. Unknown usage, cache-control failure, budget exhaustion or repeated execution failures would stop the campaign. Incomplete provider output is scored as a failed delivery, not hidden as a transport retry.

The full plan completed with **59,592 reported tokens (59.6% of the ceiling)**. All provider usage reconciles with SDK totals. There were no unpaired attempts, retries or additional paid calls after the planned sixteen. No dollar estimate is claimed. The SDK's completed task status was not used as evidence of provider completion or quality.

Nine offline meter, hard-grader and paired-statistics tests passed (42 assertions), along with tooling types, architecture and stable-contract checks. Independent reconciliation verified all assigned caps, exactly one request per attempt, cache isolation, paired input-token equality, the full ledger, means and exact paired p values.

## Decision

For these harder tasks, **4,096 is the better explicit experimental choice**: observed truncations disappeared and substantially more complete repairs passed validation, for about 15% more tokens and 3.5 seconds more per attempt. Preserve response-completion and executable-quality checks because two larger-cap answers still failed. Keep runtime defaults and automatic preload behavior unchanged; this campaign is not a mandate for a global budget increase.
