# OpenAI reasoning effort comparison — 2026-11-13

`low` reduced token consumption but did not reduce total latency in this campaign. The default remains unchanged. OpenAI returned `medium` when the harness used `default` (effort omitted), and `low` when explicitly requested. Both returned model `gpt-6-luna`.

[Machine-readable evidence](REASONING_EFFORT_2026-11-13.json) includes every measured observation, per-call milestones and usage, paired statistics, protocol, artifact hashes and supplementary blinded review. Raw synthetic answers and immutable executable bundles remain locally under `results/reasoning-low-2026-11-13/` (Git-ignored).

## Design and budget

18 paired comparisons, 36 tasks, 72 real OpenAI Responses requests. Six pairs each tested factual extraction, arithmetic and a small Boolean code review. Each task read two files in one `read_files` call and returned JSON with an 80–100-word explanation. Each variant ran first three times per fixture; the balanced plan was shuffled with a fixed seed. Both used the same runtime bundle, Node v22.21.0, 40 historical activity runs, tools, prompt and limits. Execution was sequential, with no unrelated builds/tests during measurement. Start: 2026-11-14 01:58 UTC / November 13 22:58 Argentina time.

The fixed plan was declared before inspecting latency. Primary endpoint: paired total task latency. All completed pairs enter the latency analysis even if quality fails. Confidence intervals use 10,000 paired bootstrap resamples stratified by fixture; no significance-based stopping. The 18 pairs were all complete, with none excluded. Per-fixture and per-call intervals are exploratory, without multiplicity correction.

Budget: 90,000 aggregate reported tokens; 12,288 reserved before starting each pair. Each task allowed at most 6,144 total tokens, three requests, 1,024 output tokens per response, 60 seconds execution and 75 seconds worker lifetime. Identical transport retries were refused. Missing usage or consecutive execution failures would stop the campaign. Actual consumption was **71,480 tokens (79.4% of budget)**, with all 72 response usage records present and totals matching SDK task usage. No failures, incomplete responses or retries occurred. No additional paid judging calls were made. Tokens are the consumption measure; no dollar estimate or billing reconciliation is claimed.

## Results

| Metric | Default (medium returned) | Low | Difference |
| --- | ---: | ---: | ---: |
| Mean total latency | 6,590 ms | 7,079 ms | low +489 ms (+7.4%) |
| Median total latency | 6,474 ms | 7,466 ms | low +992 ms |
| Mean first visible text, from task start | 5,514 ms | 5,694 ms | low +179 ms |
| Input tokens, 18 tasks | 26,388 | 26,388 | unchanged |
| Output tokens, including reasoning | 10,848 | 7,856 | −27.6% |
| Reasoning tokens (subset of output) | 7,518 | 4,519 | −39.9% |
| Total tokens | 37,236 | 34,244 | −8.0% |
| All quality criteria passed | 18/18 | 18/18 | no observed loss |

The primary 95% bootstrap interval for **low minus default** total latency is **+107 to +865 ms**. Low was faster in 8/18 pairs. First-visible-text difference is inconclusive: −210 to +561 ms for low minus default. No cached input tokens were reported, and input usage was identical across variants. Non-reasoning output totals were nearly identical: 3,330 versus 3,337 tokens. The saving came from reasoning, not a substantially shorter delivered answer.

## What dominates the latency

Per-call times below start when the intercepted fetch begins and end when the corresponding SSE event is observed. They include network, service work and downstream consumption/backpressure; they do not isolate provider compute.

| Mean milestone | Default | Low |
| --- | ---: | ---: |
| Call 1: response headers | 572 ms | 651 ms |
| Call 1: first tool event | 977 ms | 1,282 ms |
| Call 1: terminal event | 1,403 ms | 1,781 ms |
| Call 2: response headers | 542 ms | 552 ms |
| Call 2: first text | 4,018 ms | 3,823 ms |
| Call 2: terminal event | 5,027 ms | 5,138 ms |
| Actual file tool execution | 2.65 ms | 2.90 ms |
| Activity persistence across task | 295 ms | 333 ms |

The second model call still dominates the measured time. Its terminal latency did not improve conclusively (low minus default +112 ms, exploratory CI −183 to +404 ms), despite all reasoning-token savings occurring there. The first call reported zero reasoning tokens in both variants yet was +377 ms slower with low, accounting for approximately 77% of the overall mean gap. This is an observed association; client timings cannot explain whether routing, scheduling, network or server execution caused it.

Summed terminal call intervals occupy approximately 97.6% of default task time and 97.7% of low task time. Activity callbacks can occur within those intervals: **do not add activity duration on top of model time**. The residual outside the two intervals is approximately 160 ms for both modes. Actual file reads are negligible here. No reasoning delta means an unavailable timing milestone, not zero reasoning duration.

By fixture, low minus default mean total latency was +816 ms for arithmetic, +1,151 ms for facts and −499 ms for code review. The code-review exploratory interval crosses zero. Both execution-order groups show higher overall low latency. Six pairs per fixture and one measurement window do not establish a reusable task-routing rule.

## Quality and instrumentation

Every task completed, called `read_files` successfully for exactly the two expected paths and met strict JSON keys, exact expected fields and explanation length. A supplementary assistant review of all 36 explanations, with condition labels hidden, found factual consistency and no material unsupported claim. This was not independent human evaluation; deterministic tests do not measure all semantic properties. Three small synthetic fixtures cannot establish quality equivalence for complex repository changes or multi-step reasoning.

The experimental transport meter records per-call start, request byte count, requested/returned effort, model, HTTP status, headers, first SSE event, first reasoning/text/tool event when present, terminal event, stream end, interruption and usage (including cached/reasoning tokens). It does not retain headers, request bodies or reasoning text. Synthetic final answers are retained separately only for grading. Streaming tests cover fragmented UTF-8, duplicate terminal events, incomplete/broken streams, effort verification and retry refusal.

Runtime tool telemetry now wraps the final governed tool set in ordinary runs as well as task-budget runs. Previously ordinary runs could report zero tools. The previous task-budget-only telemetry wrapping was removed to avoid double counting. No default effort, provider configuration or output policy was changed.

## Execution incident and validation

The frozen campaign bundle inadvertently included the old latency benchmark's entrypoint through a shared statistics import. That old entrypoint failed before any request: missing `--baseline` in the parent and missing `--model` in children. It set a nonzero process exit status without stopping the real campaign. Consequently the parent exited 1, while the campaign correctly reached `planned-completion` with all 36 tasks and 72 HTTP 200 terminal responses fully metered. The diagnostic occurred outside task timing in both groups; no extra API calls were made. These records were retained, not silently discarded or rerun.

Shared statistical helpers now live in an entrypoint-free module. An offline smoke of the corrected bundle verified a single expected opt-in rejection without the old entrypoint. Original paid-run artifacts and their hashes remain unchanged; corrected source is distinct from the frozen worker hash. The incident and the single-window sample are reasons to replicate before a production latency decision.

Validation: 88 targeted tests passed (383 assertions), covering streaming instrumentation, grading, paired statistics, telemetry, context, scheduling and task-budget behavior. Type checking for source and tooling, architecture and stable-contract checks were also run. This is targeted validation, not a new claim of full release certification.

## Decision

Keep `default`. Low is a promising **explicit consumption-saving option** for these simple tasks, but the evidence does not support adopting it as a latency optimization. The next high-impact experiment should test eliminating an unnecessary model round trip when the application already knows which context to load, with quality and authorization checks preserved. Measure that separately from effort selection. A replication of low versus default across another time window and harder tasks should precede any default or automatic routing change. No further paid experiment or default change is part of this result.
