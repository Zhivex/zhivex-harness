# One-retry recovery of the two 4,096-token failures

Exactly one real OpenAI retry was attempted for each of the two saved failures from the [direct cap comparison](PRELOAD_CAP_AB_2026-11-14.md). **One recovered completely; the other corrected its code but returned invalid JSON and remained rejected.** No further retry or silent response repair was performed. Runtime defaults and automatic recovery behavior remain unchanged.

[Full evidence](PRELOAD_RETRY_ONCE_2026-11-14.json) includes both original failed answers, the original cohort, both retry answers and usage, automatic diagnostics, validation results, reconstructed metrics and source/runtime hashes. Frozen artifacts remain locally under `results/preload-recovery-2026-11-14/`.

## Failure analysis and automatic feedback

**Original pair 2: nontermination.** The planner builds a ready set without excluding jobs already in `completed`. A dependency-free job remains ready forever, so the loop keeps scheduling it. The full evaluator timed out on ten of eleven functional cases. A separate diagnostic reproduced the failure with just `planJobs([{id:'probe',deps:[]}])` under a 100 ms limit. Feedback supplied that input, the expected single round and the timeout, without providing replacement code.

**Original pair 8: malformed JSON.** The response contains a complete candidate object followed by extra delimiters. Strict `JSON.parse` rejects it before functional evaluation. Feedback asks for exactly one valid JSON object, correct escaping/delimiters and no trailing content. It does not guess or silently discard parts of the response.

Both retries receive the same preloaded source/contract/example/test files and scoped instructions as before, the complete previous answer labelled as untrusted task data, the diagnostic and the unchanged output contract. The model must return the complete JSON object, not an edit fragment. Output remains capped at 4,096, reasoning remains omitted/default (`medium` returned), and tools are unavailable for model selection after host preload. The compiled runtime hash is identical to the original campaign.

## Predeclared experiment and controls

This is a **retrospective selected-failure recovery experiment**, not a newly randomized end-to-end cohort. The six original successes are revalidated locally and retained, not regenerated. The two recorded failures receive one new call each. A failure of that recovery is terminal for this experiment. There is no comparison against a blind retry or a different feedback strategy, and two cases cannot estimate a general recovery probability.

The additional token ceiling was **32,768**, with 16,384 conservatively reserved before each retry. Both attempts used the existing bounded input/output/total task budgets and timeouts, and the transport meter allowed one request per retry and rejected repeated requests. A unique cache key was assigned per call; both responses explicitly reported **zero cached input tokens**, with different key hashes. The source cohort also had zero reported cache reads.

The original acceptance suite remains primary: strict JSON/schema, 120–160 explanation words, eleven functional and input-nonmutation cases, and three distinct valid regression examples that fail the original repository implementation. Six additional planner checks were defined before live retries and withheld from feedback: a diamond dependency chain, a cycle with downstream work, mixed disabled/missing propagation, Unicode/code-unit ordering with duplicate dependencies, a self-cycle and empty input. Explanation semantics are not independently judged.

## Results by failure

| Original failure | Retry outcome | Additional wall time incl. validation | New tokens |
| --- | --- | ---: | ---: |
| Pair 2: loop repeats completed jobs | Function corrected, but trailing `]}` makes JSON invalid; rejected | 15.99 s | 3,522 |
| Pair 8: malformed JSON | Valid complete answer; all original criteria and 6/6 new checks passed | 13.19 s | 3,399 |

Both responses ended `response.completed`; neither was truncated. They used 1,343 and 1,236 output tokens respectively (755 and 626 reasoning tokens). Provider completion is not acceptance: the first remains a failed delivery.

For diagnosis only, the complete leading JSON object of the first retry was extracted offline. That isolated object passed all eleven functional cases, all three regression checks, the length/schema checks and all six additional checks. This confirms that the nontermination bug was corrected and the remaining defect is output framing. **The raw response was not changed, accepted or counted as recovered.** This post-hoc prefix extraction is separate from the predeclared one-retry policy and is retained explicitly in the evidence.

## Quality, latency and consumption comparison

The following table reconstructs the original eight-task 4,096-cap cohort with one retry applied only to its failures:

| Metric | Original cohort | With one retry on failures |
| --- | ---: | ---: |
| Tasks passing all primary criteria | 6/8 | **7/8** |
| Model requests | 8 | 10 |
| Total tokens | 31,822 | **38,743** |
| Mean cumulative task time, including validation | 24.69 s | **28.34 s** |
| Mean incremental time per original task | — | **3.65 s** |

New spending was **6,921/32,768 tokens (21.1% of the additional ceiling)**. Reconstructed cohort consumption rose **21.7%**. The mean retry cost among the two retried tasks was **14.59 seconds** including diagnostics, the call and result validation. The failed loop task accumulated 44.13 seconds and still failed delivery; the JSON task accumulated 34.46 seconds and passed.

**Timing method:** original recorded task wall time plus a newly measured local validation pass forms the baseline. For a retried task, add its newly measured task wall time (which already includes diagnostic generation and preload) and its result-validation time. Do not add diagnostic time again. Startup/history seeding, worker launch, scheduling gaps between campaigns and teardown are excluded consistently from task intervals. The original loop's validation alone took approximately 1.36 seconds due to its repeated timeouts. These are reconstructed cumulative durations, not measurements of a fresh single-session recovery path or evidence of a population latency effect.

All current usage is fully metered and matches SDK totals. The 38,743-token reconstruction contains only the original 4,096 arm and these retries; it does not include the earlier 2,048 arm. No dollar estimate or further paid attempt is included. Success on one of two deliberately selected failures must not be generalized to a 50% production recovery rate.

## Validation and decision

The offline tests reproduce the parser and loop failure classes, verify additional-check reference answers, reject destructive candidates, and retain the existing hard-grader and transport-meter checks. Tooling types, architecture and contract checks passed. Independent reconciliation verified two distinct source failure IDs, one call each, cache usage, requested/returned effort, output caps, full token ledger and the cumulative-time arithmetic.

The experiment supports a bounded opportunity to recover a failed answer, but it also shows why the retry must cross the same final acceptance gate: fixing one defect can leave or introduce another. Keep automatic retries disabled by default, preserve rejected answers and their diagnostics, and do not treat a successful model response as a successful repair. An explicit structured-output or separately specified deterministic framing-repair experiment could address this remaining format failure; neither was introduced or counted here.
