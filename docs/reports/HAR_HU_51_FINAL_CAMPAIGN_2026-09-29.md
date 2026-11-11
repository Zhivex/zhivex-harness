# HU51: final Sonnet 5.5 pilot result

Plan `sha256:e9d7bd8c3dc5de45be95e31d4a6729bce9d96014fae014c8f490cb69be3320b1`. Tarball `1dc3375ab8c4a70a4c100fec45087ee9569d3522970e04be8b4ce65e5a5ea7ec`. All 42 predeclared cases finished, with one attempt per cell; no selective retries.

## Method

Harness 1.3.0-rc.3 versus a reference built with SDK core 1.26.0 / agents 1.10.1; shared Anthropic 0.12.4 transport from the installed artifact. SDK versions and bytes in the evaluator and installed consumer are identical and checked before each case. Both request `claude-sonnet-5-5` through direct API and streaming. This is not a comparison with commercial products and does not guarantee an immutable snapshot of model weights.

Seven HU44 fixtures, three repetitions and rotating order. Common limits per complete case: 150 s, 16 model requests, 40 tool calls, 60000 input tokens, 8192 output and 68192 total. The counter persists across approvals, reopening and user correction. Limits were not increased after observing failures.

Independent tests and package.json remain protected. Approvals of allowed changes and the exact check are automatic and counted separately from human intervention. Cancellation passes through absence of effects; it does not mean the bug was repaired. Pilot reopening occurs within the same worker, with compaction required; HU45 provides separate cross-process tests.

## Results

| Participant | Success | Cumulative time | Reported input | Reported output | Complete usage | Automatic approvals |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| harness | 18/21 | 237.375 s | 832712 | 19072 | True | 51 |
| sdk-reference | 21/21 | 274.598 s | 173007 | 20892 | True | 67 |

| Task | Harness | SDK reference |
| --- | ---: | ---: |
| bug | 3/3 | 3/3 |
| multi-file | 3/3 | 3/3 |
| failed-check | 3/3 | 3/3 |
| user-correction | 0/3 | 3/3 |
| compaction-restart | 3/3 | 3/3 |
| approval | 3/3 | 3/3 |
| cancellation | 3/3 | 3/3 |

Protected files preserved in 42/42 cases. Human interventions: 0. Scripted corrections: 6. Monetary cost is unknown, not zero: no pricing source was fixed. Tokens do not constitute billing.

Observed failures and reasons are complete in the JSON. Budget rejections are conservative admission decisions before a new request; they do not mean 60000 tokens were consumed. Producing a partial modification does not turn them into successes.

For the 18 pairs where both completed: median Harness duration 10.978 s, reference 12.531 s; cumulative input 675750 versus 117904 tokens. Failures are excluded from this comparison but remain in the overall rate. This small, nonrandom sample does not prove speed or market superiority.

## What works and what remains for production

The sample verifies governed editing, checks, approval, cancellation and continuity in the stated scenarios. The shared-budget correction limit prevents a general production recommendation for this configuration. Reduce context and schemas sent per request, measure context retention per turn and size budgets with evidence; always preserve permissions, approval and independent verification. A repository map is not justified: the failures are not discovery failures in large repositories.

Fixed during investigation: the pilot omitted signed-block normalization; budget/OCI finalization misplaced system instructions; the pilot compaction threshold did not admit indivisible groups; memory loading separated system instructions during continuation, and current instructions were duplicated. Each previous campaign retains its plan, observations and failures; its figures are not mixed with this candidate.

HU45 from the same hash: six routes pass selected gates, continuity 36/36 and four cross-routes; nine OCI scenarios and 18 delegation phases installed on Node 22.13. Final suite: 1878 passed, 1 skipped, 0 failed. Build, types, architecture, contract and documentation pass; pilot inventory was additionally validated with types and plan preparation.

Complete evidence: HAR_HU_51_FINAL_CAMPAIGN_2026-09-29.json and HAR_HU_51_SONNET_55_FINAL_PLAN_2026-09-29.json. No commit, push, PR, package publication or formal support promotion. Implementation remains for review; the report describes limits, not general production certification.
