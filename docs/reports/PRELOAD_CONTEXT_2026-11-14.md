# Known-file preload experiment — 2026-11-14

Explicitly preloading the two known files reduced total latency by **20.1%** and token consumption by **32.7%** in this controlled OpenAI campaign. The benchmark changes only how context is supplied. **Production behavior and default reasoning effort remain unchanged.**

[Full numerical evidence and synthetic answers](PRELOAD_CONTEXT_2026-11-14.json) preserve all observations, quality outcomes, protocol, artifact hashes and supplementary blinded review. The immutable executable bundles and original campaign are also retained locally under `results/preload-context-2026-11-14/` (Git-ignored).

## Comparison and budget

18 paired comparisons, 36 tasks: six pairs each for factual extraction, arithmetic and a small Boolean code review. Within each fixture, each variant ran first three times. The balanced plan was shuffled with seed 20261115 before measurement. All completed pairs enter the latency analysis regardless of quality; no significance stopping or retries. The primary endpoint is paired total task latency with a 10,000-resample bootstrap stratified by fixture. Per-fixture, order and call-level analyses are exploratory.

Both variants used the same frozen runtime, Node v22.21.0, OpenAI `gpt-6-luna`, Responses streaming, omitted reasoning effort (server returned `medium` in all 54 responses), available `read_files` tool, output constraints and 40 historical activity runs. Both asked for exact JSON fields and an 80–100-word explanation. The control was rerun in this campaign; earlier default/low measurements are not reused as a baseline. Start: November 14, 2026, 08:01 Argentina time (11:01 UTC).

- **Tool:** the model requests `a.txt` and `b.txt` together, receives the tool result and generates the answer.
- **Preload:** the host reads these explicitly selected files with `harness.workspace.readFiles`, serializes the same bounded, line-numbered snapshots and digests into the prompt as file data, and asks the model to answer without rereading them. The tool remains available. No fabricated tool calls or prior assistant messages are inserted.

Total time starts before the host read and serialization. It includes model calls, tool execution and synchronous activity callbacks, but excludes common harness construction/history seeding and teardown. Preload duration and byte count are separately recorded. First text means delivery to the host callback, not browser rendering; its timing includes the offset before `runHarnessTask` starts.

The token budget was **75,000**, with 12,288 reserved before each pair; per-task limits were 6,144 total tokens, at most three requests, 1,024 output tokens per response and a 60-second execution abort (75-second worker timeout). Unknown usage, exceeded budget or repeated execution failure would stop the campaign. Actual usage was **61,454 tokens (81.9%)**. Every response had usage, with task totals matching SDK usage. All workers exited successfully. No retries, incomplete responses, unmetered requests or extra paid judging calls occurred. Consumption is reported in tokens, not estimated dollars.

## Results

| Metric | Tool | Preload | Change |
| --- | ---: | ---: | ---: |
| Mean total latency | 7,331 ms | 5,855 ms | −1,477 ms / −20.1% |
| Median total latency | 7,126 ms | 5,633 ms | −1,493 ms |
| Mean first text to host | 6,179 ms | 4,646 ms | −1,532 ms / −24.8% |
| Requests, 18 tasks | 36 | 18 | −50% |
| Input tokens | 26,388 | 14,874 | −43.6% |
| Output tokens, including reasoning | 10,348 | 9,844 | −4.9% |
| Reasoning tokens, subset of output | 6,981 | 7,312 | +4.7% |
| Total tokens | 36,736 | 24,718 | −32.7% |
| Correct facts and JSON format | 18/18 | 18/18 | no observed loss |
| All quality criteria | 17/18 | 18/18 | one control length failure |

The primary interval for mean latency reduction is **1,051–1,887 ms (95% paired bootstrap)**. Preload was faster in **17/18 pairs** and used fewer tokens in **18/18 pairs**. The first-text reduction interval is 1,111–1,938 ms. No input caching was reported in either variant. The aggregate token reduction is primarily less input across requests, not reduced reasoning: reasoning usage actually increased slightly, with an inconclusive paired difference.

All 18 preload tasks made exactly one model request and zero tool calls. All 18 control tasks made exactly two requests and one successful `read_files` call. Thus the intended mechanism occurred in every pair, not only in a selected subset.

## Where the improvement comes from

| Mean interval | Tool | Preload |
| --- | ---: | ---: |
| Initial model call to request files, through terminal SSE | 1,587 ms | absent |
| Answer-generating model call, through terminal SSE | 5,587 ms | 5,760 ms |
| Host preload and serialization | absent | 0.79 ms |
| Model-invoked file tool | 2.58 ms | absent |
| Activity callback persistence across task | 304 ms | 280 ms |

The measured gain is consistent with eliminating the initial model round trip. The answer-generating call was not faster: its mean increased by 173 ms, with an exploratory interval spanning both improvement and regression. Its reasoning tokens did not decrease either. The final call now occupies approximately 98.4% of total preload task time and remains the main latency contributor.

Call intervals measure client-observed transport/SSE consumption, including network, provider work and downstream backpressure; they are not isolated server compute time. Activity callbacks overlap those intervals, so adding activity time to model time would double count. The evidence JSON includes both first-position and final-call comparisons: first-position calls have different purposes across variants and must not be interpreted as equal work.

Mean total reductions were 1,097 ms for arithmetic, 2,277 ms for facts and 1,057 ms for code review. Both execution-order groups improved (1,444 and 1,510 ms). These are small exploratory subsets; the primary conclusion uses all 18 pairs.

## Quality and boundaries

Every answer had correct exact fields and strict JSON format. All preloads supplied both expected paths without a redundant tool call. One control code-review answer had **77 words**, below the requested 80–100, and remained in the latency analysis. Preload passed all criteria in 18/18 tasks. This does not establish a statistically reliable quality improvement.

A supplementary assistant review of all 36 explanations with variant labels hidden, performed before latency analysis, found no material unsupported claims or inconsistency with the fixtures. The answers and blinded mapping are preserved for audit. This is not independent human evaluation; wording can sometimes suggest the context route. Three simple synthetic tasks cannot establish quality equivalence for complex repository changes, adversarial file content or dynamically discovered dependencies.

The preload uses the existing bounded workspace reader, preserving path, file identity, byte and line limits. Offline tests verified identical snapshots and rejection of external symlinks. This experiment directly invokes the host reader only for synthetic files explicitly selected by the benchmark. It does **not** establish parity with every tool-policy, approval, isolated-execution, audit or scoped-instruction lifecycle. A production implementation must use the active authorized workspace, preserve those checks, record context provenance/freshness and bound the supplied context. Prompt delimiters are data labels, not a proven defense against hostile file instructions.

The treatment necessarily changes context placement and the instruction to read files. The comparison tests that combined host-preload strategy; it does not isolate round-trip count from prompt placement as independent causal factors. The single measurement window and repeated small fixtures also limit generalization. No defaults or production preload API were introduced.

## Validation and decision

Eight focused tests passed (32 assertions): bounded preload equivalence, external symlink rejection, streaming metrics, effort/cap/retry checks, grading and paired statistics. Tooling typecheck passed. An offline smoke checked the bundled entrypoint before live use. Independent reconciliation verified 36 completed tasks, 54 HTTP 200 completed responses, 61,454 tokens, default effort on the wire and the reported mean latencies. No builds or test suites ran during paid measurement.

The next implementation candidate is an **explicit, opt-in known-file preload**, preserving the existing read and authorization lifecycle. This campaign supports prioritizing that over lowering reasoning effort for latency. Validate larger files, stale snapshots, scoped instructions and realistic repository tasks before adopting it broadly. The current default remains unchanged.
