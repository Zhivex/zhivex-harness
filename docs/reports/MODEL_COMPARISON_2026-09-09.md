# Frozen model comparison and verifier recovery

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

The controlled development comparison started on September 8 and finished on
September 9, 2026 (Argentina time). It repeats the five previously inspected
SWE-bench Verified cases, with one attempt per candidate and model configuration.
It does not establish holdout performance or model-quality causality.

## Frozen comparison

Both matrices used identical hashes for all 52 implementation files, verified
against the checkout and each archived source snapshot after completion. Tasks,
images, budgets, native tool inventory, compaction and verification policy were
unchanged across providers. Both matrices ran concurrently on the same host;
latency is not a controlled comparison.

| Configuration | Zhivex resolved | mini-SWE-agent resolved | Zhivex input tokens | mini input tokens |
| --- | ---: | ---: | ---: | ---: |
| OpenAI `gpt-5.6-luna`, low reasoning, Responses | 1/5 | 3/5 | 419,336 | 309,274 |
| Qwen `qwen3.8-flash`, thinking disabled, Chat Completions | 0/5 | 2/5 | 524,135 | 371,119 |

All 20 samples have complete usage, no missing samples and no grading failures.
Totals include unresolved attempts. No price rates were supplied. Limits per
attempt were 24 steps, 2,048 output tokens per response, 100,000 cumulative input
tokens, 16,000 cumulative output tokens and 300 seconds. A response can cross the
cumulative ceiling before the next request is blocked.

Native verified import was mandatory for both providers. Mini retained its
upstream submission loop for both providers; native and external tools are not
identical. The configuration bundles model, reasoning and API transport, so the
experiment isolates the harness version but does not isolate those three factors.

### Observed failure boundaries

- Qwen: all five native attempts exhausted the input budget and exported no patch.
- OpenAI: three native attempts exhausted the input budget. Scikit-learn 14141
  resolved. Django 11265 reached a verifier failure, exit code 1, and did not import.
- The OpenAI Django verifier exit was identified by an exact SHA-256 match of the
  runtime-generated failure message; the specific assertion/command output was
  not retained, so the cause of that verifier failure remains unknown.
- Some SDK guardrail stops return `status: failed` with a null top-level `failure`.
  Interpretation uses the status, typed guardrail and terminal diagnostics together;
  a null failure string is not evidence of success.
- Empty patches count as unresolved without executing hidden tests.

The frozen result supports prioritizing context consumption. Reducing the
compaction threshold alone did not prevent repeated exploration. It does not
support blaming Qwen's adapter for the five budget stops or claiming that an
untested model such as Muse would fix them.

Sanitized evidence: [OpenAI](../../benchmarks/baselines/external-matched-openai-2026-09-08.json)
and [Qwen](../../benchmarks/baselines/external-matched-qwen-2026-09-08.json).
Local source snapshots and official grading artifacts are in
`results/swebench/matched-{openai,qwen}-2026-09-08/`.

## Isolated verifier recovery

After both frozen matrices completed, the harness gained an optional
`runHarness` setting, `maxTerminalVerificationRetries` (integer 0–3, default 0).
The external driver enables two corrections. Only a typed failure from
`verify_and_apply_environment_patch`, with a normal positive exit code below 124,
is eligible. Reserved/signal exits, timeouts, cancellation, authorization failures
and indeterminate durable executions remain terminal. Failed verification never
imports a patch. Each corrected call requires a fresh content-bound approval.

The failed attempt is journaled and returned as an error observation with a typed
exit code and instructions to diagnose the failure. The retry count is derived
from persisted failure receipts, so restarting an approval continuation cannot
reset it. No raw verifier logs are added to diagnostic telemetry.

Seven deterministic regressions exercise correction and successful import, retry
exhaustion, exhaustion after durable resume, the unchanged default behavior,
timeout, cancellation and output-limit termination. Existing terminal denial and
stale-digest tests remain in place. These fixtures establish the recovery mechanism,
not competitive repair quality.

A separate four-attempt OpenAI development ablation was predeclared: Django 11265
(the observed verifier failure) and scikit-learn 14141 (the resolved control), each
with native and unchanged external candidates. Only the verifier-recovery source
and its driver opt-in changed; model, budgets and context settings stayed fixed.
The selection deliberately uses inspected results.

| Candidate | Frozen baseline, same two tasks | Recovery enabled |
| --- | ---: | ---: |
| Zhivex | 1/2 | 1/2 |
| mini-SWE-agent | 1/2 | 1/2 |

All four attempts completed with full usage and no grading failures. All 52
treatment hashes matched checkout and archive; exactly `src/harness.ts` and
`scripts/swebench/zhivex-driver.ts` differed from the frozen implementation.
Scikit-learn 14141 still resolved. The native Django attempt consumed 102,877
input tokens in 15 model calls, ending on the input budget during exploration.
It never called the verifier, so this run did not exercise live recovery and
does not demonstrate a resolution improvement. The unchanged external candidate
also resolved only scikit-learn. A zero paired difference on two selected cases
is not evidence of general equivalence.

The [sanitized ablation](../../benchmarks/baselines/external-verifier-recovery-2026-09-09.json)
preserves all four samples. Local artifacts are under
`results/swebench/verifier-recovery-openai-2026-09-09/`.

Validation: 453 tests passed, including the seven recovery regressions. Contracts,
types, docs, migrations, deterministic evaluations and local benchmarks passed.
The aggregate check reached the sandbox's local-port restriction at MCP; MCP
(controlled and official), real OCI and installed-package smokes subsequently
passed with the required escalation. The correction fixture was additionally
rerun with distinct verifier argv, confirming a fresh approval for the corrected
command. No commit, push or release was performed.

## SDK follow-up

Update: published Core 1.14.0 and Agents 1.4.0 have now been installed in the
harness. The native driver explicitly enables `validationErrorMode: "tool-result"`.
Consumer regressions confirm correction, bounded errors, sanitized issue paths,
and approval continuation with complete usage. The historical failure below
describes Core 1.13.0; the frozen live results above predate this upgrade and are
not measurements of the new SDK.

Core 1.13.0 independently reproduces a fatal schema-validation error despite
`toolExecution.stopOnError: false`: the validation occurs before the recoverable
execution loop. No invalid tool is executed, but the model cannot correct its
arguments within that loop. A mock model reproduced this without HTTP or Qwen.

The [SDK story in Zhivex](https://app.notion.com/p/3d6777b104f681138a37c547a6db3bd5)
requests explicit, bounded provider-neutral validation recovery, zero execution of
invalid arguments, preserved approval/guardrail boundaries and paired tool history.
It includes a runnable reproduction and acceptance criteria. It is separate from
the already-completed Responses parser story. No SDK package or schema was patched
locally to bypass the validation.

## Qwen rerun with Core 1.14 and progress controls

The predeclared ten-attempt development rerun used the same five tasks, image
digests, Qwen 3.8 Flash with thinking disabled, and unchanged budgets. It combined
Core 1.14.0 / Agents 1.4.0 schema recovery, compaction v3, progress controls and
bounded terminal-verifier recovery. Qwen remained 0.11.4. Individual effects are
not isolated, and this inspected cohort is not a fresh holdout.

| Candidate | Previous matched Qwen run | Updated run | Recorded input tokens |
| --- | ---: | ---: | ---: |
| Zhivex | 0/5 | 0/5 | 493,929, incomplete |
| mini-SWE-agent | 2/5 | 2/5 | 366,258, complete |

All ten attempts were recorded with no grading infrastructure failures. All 54
implementation hashes matched both checkout and archived snapshot. Nine attempts
had complete usage. Native SymPy failed after ten model requests, with usage from
only nine responses; its recorded 61,527 input tokens are a lower bound. The
native aggregate therefore cannot establish token or cost savings against the
previous 524,135 complete input tokens. Monetary costs remain unknown.

The new SDK recovery was exercised live twice: invalid `read_files` arguments
at scikit-learn 10908 step 3 and invalid `search_many` arguments at Django 15554
step 10 became error observations followed by successful calls of the same tool.
Neither ended the run. Four native attempts instead exhausted the input budget;
SymPy ended with `EXECUTION_FAILED` and fingerprint
`3eba321b9573f380146626281ff9c8da1b22d77e355a18047e3a62394c9c5afe`.
The sanitized evidence does not identify its underlying cause or establish SDK
ownership. No additional SDK story is justified by that fingerprint alone.

All five native patches were empty and no native attempt reached terminal
verification. Closure activated in four runs but blocked only one broad call.
There were zero repeated-result detections or suppressions. This shows why exact
duplicate suppression did not address this run's exploration pattern: distinct
reads, scoped searches and commands continued to consume the remaining budget.
Verifier recovery was not exercised and cannot explain this result.

Across the 66 native requests, context instrumentation counted 674,906 tool-result
characters, 437,514 tool-definition characters, 298,848 system characters, 196,028
assistant characters and 68,341 user characters. No definitions or measurements
were omitted. These are cumulative provider-neutral serialization sizes, not
billed-token attribution. They identify repeated tool schemas and retained tool
results as concrete surfaces to measure in a later ablation.

The next harness experiment should constrain exploration across distinct reads
and shell commands, require a repair hypothesis earlier, and measure a smaller
phase-specific tool catalog. It must preserve approval and verification controls.
The current result does not demonstrate improved repair quality or competitiveness.

The [sanitized rerun](../../benchmarks/baselines/external-qwen-sdk-114-progress-2026-09-09.json)
contains the protocol, all ten samples, source hashes and analysis. Raw local
artifacts are under `results/swebench/qwen-sdk-114-progress-2026-09-09/`.
This follow-up changed evidence and documentation only; the implementation stayed
frozen throughout the matrix.
