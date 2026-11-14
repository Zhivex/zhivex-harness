# Explicit known-file preload implementation and repository validation

The experimental `runHarnessTask` host API now accepts `preloadFiles`. It remains opt-in and reuses the governed local `read_files` executor, scoped-instruction discovery, task-budget and telemetry wrappers. No default effort or automatic preload behavior changed. Usage and support boundaries are documented in [Context engineering](../CONTEXT_ENGINEERING.md#explicit-known-file-preload-experimental).

[Evidence JSON](KNOWN_FILE_PRELOAD_2026-11-14.json) retains both live cohorts, all attempted outcomes and synthetic answers, per-call timings/usage, source and executable hashes, and the combined consumption ledger. Frozen bundles remain locally in `results/repository-preload-2026-11-14/`.

## Implementation and permission boundaries

The host supplies 1–20 explicit file/range requests. Workspace protections remain authoritative: sensitive paths, traversal, symlinks, binary/nonregular files, individual/aggregate source limits and rendered-range limits. The additional serialized snapshot limit defaults to 32,000 bytes, may be lowered, and cannot exceed 64,000 bytes. It never raises workspace limits. Token admission still applies to the final model request.

Preload evaluates the agent approval policy and executes the original policy-wrapped read tool. A deny fails; an approval-required tool is refused in favor of the ordinary approval flow. Successful reads discover scoped instructions before the first model call. The final snapshot enters user context as file data, not system instructions or a fictitious assistant tool call. A durable run records selected ranges, byte count and aggregate digest under `zhivexKnownFilePreload`; individual file digests are in the bounded snapshot. The read is included in tool telemetry and total task time.

Initial support is restricted to new local runs. Resumes with the option, isolated/OCI execution, environment/tool overrides, explicit-review mode and custom tool guards fail closed rather than reading another workspace or skipping approval. There is no new CLI flag. Resumes without the option keep historical snapshots; callers must not interpret them as current filesystem state or edit authority. Every new explicit invocation reads afresh.

## More complex repository fixtures

Two synthetic repositories each contain implementation code, a data/config file, a written contract, an example test and scoped `src/AGENTS.md`. Both variants read the same four selected files and discover the same scoped instructions.

- **Invoice:** exclude cancelled rows; compute subtotal and floored basis-point discount; use discounted net for shipping threshold; handle empty/all-cancelled input; preserve input objects and supplied configuration. Six executable cases per candidate.
- **Tenant pagination:** filter tenant/deleted rows before pagination; sort by timestamp and code-unit ID tie-breaker; clamp negative offset/limit; handle empty/out-of-range pages; preserve the original rows/array. Eight executable cases per candidate.

The model returns a JSON replacement function and an 80–100-word explanation. Generated functions run in fresh VM contexts without host objects, string/Wasm code generation or imports, with a 100 ms synchronous evaluation limit. This is a bounded evaluator for these synthetic pure functions, not a general untrusted-code sandbox. Grading checks contract results and input immutability. Tests confirm that the original defective functions fail and complete reference fixes pass. The model does not edit the harness repository. This validates multi-file review and proposed repair behavior, not a full edit/approval/build/deploy workflow or broad coding competence. Explanation length is checked; explanation semantics are not independently graded.

## Retained pilot and budget correction

The initial plan used the simple-task limits: 4,096 input / 2,048 output / 6,144 total tokens per task, and 1,024 output tokens per request. It stopped automatically after consecutive execution failures at **five tasks / 6,971 tokens**. Three control tasks failed after the successful file read and before a second recorded model request. The retained sanitized diagnostic does not establish the exact underlying cause. One preload answer exhausted its output cap; another returned a candidate with literal newline escape sequences that failed executable grading. None passed all criteria. These observations were retained, not replaced.

Before a separate follow-up, limits became 8,192 input / 4,096 output / 12,288 total per task, with 2,048 output tokens per response. Both prompts asked for a single-line function to avoid the serialization ambiguity. Reasoning remained omitted/default (`medium` returned by OpenAI). These changes prevent pooling the pilot and follow-up into one latency estimate.

The follow-up planned six pairs, three per fixture, shuffled with a fixed seed and balanced initial order overall. Its independent ceiling was **53,000 tokens**, reserving 24,576 before each pair. It completed **five pairs / ten tasks / 30,507 tokens** and stopped before pair six because the remaining allowance could not cover that maximum reservation. The observed mix is two invoice pairs and three pagination pairs. The combined cap was below 60,000 tokens; actual combined usage was **37,478 tokens**, including every unsuccessful pilot task. All 20 provider responses have recorded usage. There were no automatic retries, paid judges or later paid attempts.

## Follow-up results

Both groups used `gpt-6-luna`, default reasoning, identical tools and runtime binary, sequential Node v22.21.0 workers and the same activity history. Total latency includes the host preload; initialization/history seeding and teardown are outside both timed intervals. Analysis retains the failed-quality outcome. No builds or tests ran during live measurement.

| Metric | Ordinary tool flow | Explicit preload |
| --- | ---: | ---: |
| Measured tasks | 5 | 5 |
| Mean total latency | 16.79 s | 13.54 s |
| Median total latency | 18.40 s | 12.41 s |
| Model calls | 10 | 5 |
| Input tokens | 9,864 | 6,912 |
| Output tokens including reasoning | 7,783 | 5,948 |
| Total tokens | 17,647 | 12,860 |
| Cached input tokens, subset of input | 0 | 4,136 |
| Complete quality passes | 5/5 | 4/5 |

Observed mean latency reduction: **3.25 s / 19.3%**, but the 95% paired bootstrap interval is **−2.26 to +8.17 s** and only three of five pairs were faster. The small, uneven fixture sample and asymmetric caching prevent a robust general latency claim or attribution solely to eliminating a call. Total reported tokens fell **27.1%** in this cohort; no dollar cost is claimed.

One preload pagination response consumed all **2,048 output tokens in reasoning** and terminated `response.incomplete` with no text or candidate. Although the SDK reported the task status as completed, it is a quality failure, not successful delivery. It remains in total latency and consumption. The remaining four preload candidates passed every executable case (28/28 across those four); control passed 36/36 across five candidates. These success-only test counts do not erase the missing candidate. First-text analysis has only four complete pairs and is not representative of all outcomes.

Per-call timings include network, provider work and downstream consumption/backpressure. The final answer request still dominates. Activity callbacks overlap model intervals; their durations cannot be added on top. Preload still executed one measured host read per task, so tool telemetry correctly reports one operation in both groups even though preload has no model-issued tool result.

## Validation and decision

**105 focused tests passed (432 assertions)** across ten files. Focused runtime tests cover ordinary omission, first-call scoped instructions, provenance, telemetry, policy deny/ask_user, path-scoped denial, protected/traversal paths, symlinks, binary/oversized files, aggregate source limits, rendered-context cap, ranges/count, cancellation, unsupported overrides, missing reader and fresh reads on new runs. Existing context, task telemetry, tool policy and task-budget regressions were included. Source/tooling type checks, build/declaration generation, architecture, contract and documentation checks were run.

Keep preload opt-in. It reliably eliminated the model's file-request turn in these cases and reduced observed token use, but the larger tasks exposed an output-budget failure and an inconclusive latency result. Hosts should choose only relevant known files and leave enough answer-generation budget. This validation does not justify automatic activation or a lower reasoning default. No additional paid campaign is needed to preserve that decision.
