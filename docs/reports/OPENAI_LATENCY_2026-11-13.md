# Expanded OpenAI latency comparison — 2026-11-13

**The larger sample does not establish a reduction in total task latency.**
Activity persistence is consistently faster, but the total latency difference is
small relative to variation between real model requests. This extends the earlier
[local and three-run comparison](HARNESS_PERFORMANCE_2026-11-13.md), without pooling
those observations. [Numeric results and evidence hashes](OPENAI_LATENCY_2026-11-13.json)
include all 20 final paired task times and the consumption ledger.

## Final campaign

Baseline source: `a87499d4cd78ae5edcf18c22f2e97f9828e8099f`. The optimized source
and baseline were independently bundled with the same installed dependencies.
Each worker ran in a fresh **Node 22.21.0** process against the official OpenAI
endpoint, requesting **gpt-6-luna** in Responses mode. Bundle and worker hashes
are retained in the numeric evidence. The requested model alias is fixed; this
is not an immutable provider snapshot certification.

There were **20 pairs / 40 tasks**, run sequentially. A fixed seed shuffled ten
baseline-first and ten candidate-first pairs before the campaign started. All
tasks used the same two temporary fixture files, requested one `read_files` call
and an 80–100-word explanation, and began with 40 historical activity runs.
Validity required completion, a successful `read_files` result, at least 60
output words, and no incomplete terminal provider responses. Both variants passed
20/20; no final pairs were excluded or repeated.

Primary latency is wall time around `runHarnessTask`, including its two model
requests, tool work and synchronous activity persistence. Process startup,
harness construction and history seeding are excluded. No test/build workload ran
concurrently with this final campaign. It measures this streaming read-only
workflow, not session listing, multi-file editing, approval wait, or cold CLI startup.

The primary estimator was declared before collecting the final data: mean
within-pair reduction, `baseline − candidate`, with a 95% percentile paired
bootstrap interval (10,000 deterministic resamples). Sample size was fixed, with
only consumption/failure stopping rules; latency results were computed after the
last pair. These are exploratory single-machine intervals, not cross-workload
or provider tail-latency guarantees.

## Results

| Metric | Baseline mean | Candidate mean | Mean reduction, 95% paired CI |
| --- | ---: | ---: | ---: |
| Total task latency, primary | 6,274 ms | 6,093 ms | 181 ms [−271, +671] |
| Activity-handler time | 547 ms | 333 ms | 214 ms [+196, +231] |
| First text event | 5,112 ms | 5,066 ms | 46 ms [−356, +461] |
| Sum of request-to-response-header times | 1,178 ms | 1,081 ms | 97 ms [−43, +277] |

The observed total mean reduction is **2.9%**, with the candidate faster in only
**10/20 pairs**. The primary interval includes both a 271 ms slowdown and a 671 ms
improvement. The paired geometric after/before ratio is 0.966, with interval
[0.885, 1.045]; it likewise does not establish an overall improvement. The median
within-pair reduction is −29 ms. A claim that the harness is reliably faster
end-to-end is therefore unsupported by this campaign.

Activity handling improved in **20/20 pairs**, by approximately **39%** on average.
This supports the narrower persistence improvement under this workload. Model
stream spans include consumer/backpressure time, so they are **not pure provider
compute time** and must not be added to handler time or subtracted to attribute
all remaining latency to OpenAI.

Order sensitivity reinforces the cautious interpretation: baseline-first pairs
showed +502 ms mean reduction [−360, +1,338], while candidate-first pairs showed
−139 ms [−385, +112]. Neither subgroup establishes an improvement. Order was
balanced in the primary estimate; these subgroup checks are exploratory.

## Usage and controls

| Final campaign | Baseline | Candidate |
| --- | ---: | ---: |
| Valid tasks | 20/20 | 20/20 |
| Metered HTTP responses | 40 | 40 |
| Input tokens | 25,290 | 25,414 |
| Output tokens, including reasoning | 9,865 | 9,832 |
| Total tokens | 35,155 | 35,246 |
| Cached input tokens reported | 0 | 0 |
| Mean reasoning tokens per task | 324.25 | 322.25 |
| Median output words | 84.5 | 83.5 |

The final campaign consumed **70,401 reported tokens**. Usage from terminal SSE
responses agrees with SDK totals for all 40 tasks. No incomplete responses occurred,
and each task made two metered HTTP requests. There is no observed token saving;
the 91-token aggregate difference is negligible and favors the baseline slightly.

The final campaign had a 95,000-token operational allocation. Admission reserved
12,288 tokens before starting each pair. Each task had a 6,144-total-token harness
budget (4,096 input / 2,048 output), at most three steps and HTTP requests, a
60-second task timeout and a 75-second worker deadline. The transport required an
explicit **1,024-output-token cap per response** and rejected repeated identical
request bodies. No failed task was retried. Missing/incomplete usage or two
consecutive invalid tasks stopped admission. These are operational safeguards,
not an independently enforced account-level dollar cap.

All attempts in this expansion are retained:

| Attempt group | Tasks attempted | Reported tokens | Treatment |
| --- | ---: | ---: | --- |
| Initial instrumentation attempt | 1 | Unknown | Stopped immediately; 4,096-token budget reservation retained |
| 512-token response-cap pilot | 12 | 20,198 | 9 valid; two short outputs and one exception; stopped by failure rule |
| Final 1,024-token response-cap campaign | 40 | 70,401 | 40 valid; planned completion |

Thus **90,599 tokens were reported** across the measured attempts; adding the
4,096-token reservation yields **94,695 tokens of budget accounting**, below the
120,000-token operational budget for this expansion. The initial attempt's
actual consumption was not recovered; the reservation must not be described as
measured usage or proof of the invoice total. Earlier work in the initial
performance report is outside this expansion's ledger.

The initial counter used a host option that routes MCP fetches, not model fetches.
The corrected worker guards the model's global fetch in its isolated process and
extracts only numeric usage from terminal SSE events. The 512-token pilot was not
pooled with the final campaign: both the response cap and sample plan changed.
Its failures and incomplete pairs remain in the local reports and hash bindings;
no latency estimate from it was used to decide whether to extend the final sample.

## Reproduction and validation

`scripts/benchmark-openai-latency.ts` runs the bounded campaign;
`scripts/analyze-openai-latency.ts` computes the paired analysis offline. Runtime
entry modules must export `createHarness`, `runHarnessTask` and
`openHarnessActivityStore` from their respective source versions. Build both
using `bun build --target node --packages external`, with the same dependencies.
The baseline can be exported without touching the working tree using
`git archive <baseline-commit> src package.json`. The current runner has the final
20-pair / 95,000-token / 1,024-token-response plan; it refuses to overwrite an
existing campaign directory.

```sh
bun build scripts/benchmark-openai-latency.ts --target node --packages external --outfile results/campaign.mjs
bun --env-file=.env results/campaign.mjs --live --baseline results/baseline-runtime.mjs --candidate results/candidate-runtime.mjs --directory results/new-campaign
bun scripts/analyze-openai-latency.ts results/new-campaign/campaign.json results/new-campaign/summary.json
```

The final local artifacts are under the ignored
`results/openai-latency-2026-11-13/paired-20-final/`; the earlier attempt directories
are `paired-24/` and `paired-24-v2/`. Reports retain only numeric observations,
sanitized failures and artifact hashes, not credentials, prompts or generated text.
The harness implementation was not changed during this expansion. Statistics
regression tests cover zero effects, paired covariance, deterministic intervals
and regressions; tooling typechecking and documentation checks validate the added
scripts and report.
