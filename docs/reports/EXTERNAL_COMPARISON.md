# Reproducible external comparison

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

The latest [post-remediation Qwen reevaluation](QWEN_REMEDIATION_COMPARISON_2026-09-09.md)
completed twenty attempts on five known tasks, two repetitions per candidate:
Zhivex delivered 0/10 repairs and mini-SWE-agent 4/10. Three native candidates
passed independent grading but exhausted budget before verification/import;
they do not count as completed repairs. This is a development reevaluation,
not a new holdout. The [sanitized baseline](../../benchmarks/baselines/external-qwen-remediation-2026-09-09.json)
records complete usage, all samples and 60 verified source hashes.

The earlier [frozen model comparison and isolated recovery study](MODEL_COMPARISON_2026-09-09.md)
holds the harness version and per-candidate verification policy fixed across
OpenAI and Qwen. Earlier runs below retain their original configurations.

## Repair progress controls

The native driver opts into Core 1.14.0/Agents 1.4.0 schema-error recovery with
`toolExecution.validationErrorMode: "tool-result"`. Invalid arguments produce a
sanitized error observation, allowing the model to correct the call within the
existing step/error/token limits. Invalid calls are not executed or approved.
Consumer tests exercise real harness streaming, correction, error-budget stops,
and a mixed invalid-read/valid-write batch across approval. The normal CLI retains
the SDK's strict default unless the application explicitly selects recovery.
Structured validation issue paths are retained in sanitized benchmark diagnostics.

The native comparison driver now creates one isolated progress controller per run.
After 70% of either measured cumulative input or output allowance is consumed,
`list_files` and repository-root searches are rejected with a short instruction
to proceed with focused reads/searches, reproduction, repair and verification.
This reserves the remaining allowance from those discovery tools; it does not
guarantee that 30% will reach verification or prevent exploration inside an approved
shell command. Overall SDK/transport ceilings and approvals remain enforced.

For local read/search/list tools, the third identical request returning identical
data replaces the repeated payload with a recoverable tool error. The tool still
reads current data before comparing hashes: there is no cached source substitution.
Changed results are returned normally. Commands and mutations clear repetition
history before execution, including when they fail after effects. They are never
deduplicated. The per-run history holds at most 128 input/output hashes; diagnostics
contain only counters. This wrapper preserves each tool's schema and approval fields.

`repairProgress` reports repeated/suppressed results, blocked broad calls and entry
into the closure phase. `contextMetrics` records up to 128 outbound requests split
into serialized characters for system, user, assistant, tool-result and other
messages, plus provider-neutral tool names/descriptions/JSON schemas. Unsupported
schemas increment `unmeasuredToolDefinitions`; omitted requests are counted in
`omittedContextMeasurements`. These are character measurements, not billed tokens
or exact provider wire serialization. They contain no request text. Existing actual
token counters remain the basis for budget enforcement.

These controls are enabled in the SWE-bench native driver, not automatically in
normal CLI sessions. Existing frozen baselines predate this policy and must not be
attributed to it. The post-remediation reevaluation linked above measures this
newer policy; it did not improve final resolution. The upstream external
candidate's loop is unchanged.

The current checkout integrates Core 1.14.0, Agents 1.4.0, OpenAI 0.11.2 and Qwen 0.11.4 and
removes the earlier local compaction workarounds. Existing baseline results below
belong to their archived source snapshots and dependencies, not this upgraded
runtime. A repeated-cohort evaluation of the upgraded runtime is recorded below;
it is separate from the original held-out run.

## Qwen Flash repair reevaluation — 2026-09-08

The [Qwen baseline](../../benchmarks/baselines/external-qwen-flash-2026-09-08.json)
records all ten completed attempts on the same five known tasks, one repetition.
Both candidates requested `qwen3.8-flash` through the international DashScope Chat
Completions endpoint, with thinking disabled. Limits remain 24 steps, 2,048 output
tokens per response, 100,000 cumulative input tokens, 16,000 cumulative output
tokens and 300 seconds. Budget enforcement between requests can overshoot by one
response. Pricing was not supplied.

| Candidate | Resolved | Input tokens, all attempts | Output tokens, all attempts |
| --- | ---: | ---: | ---: |
| Zhivex | 0/5 | 424,720 | 5,868 |
| mini-SWE-agent | 2/5 | 359,481 | 6,404 |

The implemented fixes support exact-file `search_many`, limit rendered reads to
16,000 characters per slice and 32,000 per batch, request behavioral assertions,
compact at 10,000 estimated input tokens, and expose remaining cumulative budget
after half is consumed. Native submission now requires a successful verifier
through `verify_and_apply_environment_patch`; mini retains its upstream submission
loop. This verification-policy difference is part of the compared products.

Three native tasks (SymPy and both Django cases) exhausted the input budget.
Scikit-learn 10908 stopped on an invalid `files[0].endLine` argument; sanitized
evidence does not establish the offending value. Scikit-learn 14141 reached final
verification, which exited with code 4 and correctly prevented host import. Its
error fingerprint exactly matches the harness's verifier-failure message; the
retained evidence does not establish why the verifier exited with that code.
All five native exported patches were empty. Mini resolved both scikit-learn
cases and exported three empty patches. Empty patches count as unresolved without
running hidden tests. All ten attempts have complete usage, with no missing samples
or grading failures.

An earlier aborted attempt used Qwen adapter 0.11.1, which missed the trailing
streamed usage chunk. The already-published upstream fix was integrated by upgrading
to 0.11.4 and verified with a live streaming tool call before this complete run.
That aborted attempt is retained separately with unknown billed usage and is not
valid comparison evidence. No duplicate SDK story is needed for the existing fix.

All 52 source hashes matched the checkout and archived snapshot after execution.
Local receipts and reports are under
`results/swebench/qwen-flash-validated-2026-09-08/`. Validation passed 446 tests,
contract/docs/type checks, migrations, deterministic evaluations, MCP checks, real
OCI smoke and the installed package smoke; network/port/container checks ran with
the required sandbox escalation.

This run did not improve resolution. Model, transport, reasoning and harness
behavior changed together relative to the preceding GPT run; it does not isolate
model quality or the effect of any individual fix. These inspected cases are
development data, not a fresh holdout. Remaining observed bottlenecks are repeated
context consumption and recovery from invalid tool arguments or failed verification.
To prepare another Qwen selection, use `prepare.py --provider qwen --model
qwen3.8-flash` with the other preparation arguments. Supply `DASHSCOPE_API_KEY` or
`QWEN_API_KEY`; the matched runner requires the default international endpoint and
rejects custom Qwen region, workspace or base-URL overrides.

## SDK upgrade reevaluation — 2026-09-08

The [sanitized baseline](../../benchmarks/baselines/external-sdk-upgrade-2026-09-08.json)
records ten completed runs with Core 1.13.0, Agents 1.3.1 and OpenAI 0.11.2.
All five tasks, candidate and evaluator images, model and budgets match the previous
final cohort. This deliberately reuses known cases, so it is not a new holdout.
Command-schema and user-correction improvements are also present; this experiment
does not isolate the SDK's causal contribution.

| Candidate | Previous resolved | Current resolved | Previous input tokens | Current input tokens |
| --- | ---: | ---: | ---: | ---: |
| Zhivex | 1/5 | 2/5 | 422,592 | 340,685 |
| mini-SWE-agent | 2/5 | 3/5 | 331,554 | 297,407 |

Zhivex used 19.4% fewer input tokens in this run; mini used 10.3% fewer. Output
tokens were 5,260 and 8,832 respectively. These totals include unsuccessful attempts.
The unchanged external control also varied, so neither the score change nor token
reduction is a causal estimate. No pricing was supplied and monetary costs remain
unknown. Five tasks and one repetition do not establish general superiority.

| Task | Zhivex | mini-SWE-agent |
| --- | --- | --- |
| sympy__sympy-21930 | Incorrect patch | Incorrect patch |
| scikit-learn__scikit-learn-10908 | Resolved | Resolved |
| django__django-15554 | Input budget exceeded | Resolved |
| scikit-learn__scikit-learn-14141 | Resolved | Resolved |
| django__django-11265 | Incorrect patch | Incorrect patch |

Zhivex now solves scikit-learn-10908, previously blocked by command authorization.
It completes the SymPy and final Django attempts within budget, but their patches
do not pass the official evaluator. One other Django attempt reaches 101,980 input
tokens; ceilings allow the documented one-response overshoot. No command-denial or
provider-protocol failures were recorded. Remaining priorities are repair correctness
and repeated context consumption, not relaxing execution permissions.

All ten samples have complete usage and grading status, with no grading failures or
protected-file changes. All five preflights passed without provider calls. After
the run, all 52 source hashes matched both the checkout and archived snapshot.
Raw receipts are local under `results/swebench/sdk-upgrade-comparison-2026-09-08/`.

### Failure analysis of the upgraded run

The requested model identifier was `gpt-5.6-luna`, through OpenAI Responses with
low reasoning, for both candidates. Limits were 24 steps, 2,048 output tokens per
response, 100,000 cumulative input tokens, 16,000 cumulative output tokens and
300 seconds per agent run. This records the requested model, not an immutable
provider model snapshot.

- **SymPy 21930:** the submitted patch only wrapped `CreateBoson._latex` in braces.
  Official grading passed two target tests but still failed `test_commutation`,
  `test_create_f`, `test_NO` and `test_Tensors`. The repair did not cover related
  rendering variants. Two exact-replacement attempts also failed because the
  old text was not a unique match; those checks should remain enforced.
- **Django 11265:** copying annotations and filtered relations into the inner
  query removed the original failure mode but did not implement correct exclusion
  semantics. `test_with_exclude` expected an author and received an empty queryset.
  One execution command is recorded, but the sanitized trace does not retain its
  arguments or exit code; it cannot establish what the agent actually verified.
- **Django 15554:** 13 model calls consumed 101,980 input tokens with two compactions.
  The recorded tools were eight searches, five reads and one listing; no edit or
  verifier execution is recorded before the budget failure. Tool responses totaled
  115,568 serialized characters. These are response characters, not unique source
  bytes or a token estimate. The empty exported patch received no hidden test run.

A confirmed harness issue contributed avoidable tool failures: `search_many` accepts
an arbitrary relative `path` in its schema, but `Workspace.searchMany` requires a
directory and the tool description does not explain that restriction. Eight errors
across four tasks have the exact SHA-256 fingerprint of the fixed message
`searchMany requires a directory.` An isolated temporary-file reproduction matches
the fingerprint; searching the containing directory succeeds. Three such failures
occurred in Django 15554. This does not prove that fixing search alone would solve it.

Priorities are file-scoped search with the existing filesystem protections, explicit
behavioral reproduction plus regression verification before submission, and bounded
read output with earlier budget-aware progress checks. Verification telemetry should
retain typed command outcomes without raw logs or secrets. No new SDK defect is
established by these failures; the terminal budget guard is expected behavior.
Any future tuning using these inspected evaluator results must treat this cohort as
development data and use fresh cases for confirmatory claims.

This opt-in pipeline compares the actual Zhivex Harness native OCI execution path
with upstream mini-SWE-agent 2.4.6 on a pinned selection of SWE-bench Verified.
It does not relabel the internal `direct` profile as an external product.

The scorer is SWE-bench 4.1.0, which accepts the original Verified dataset columns.
SWE-bench 5.x expects precomputed evaluation metadata absent from this pinned
revision. The dependency lock includes hashes. See the upstream
[mini-SWE-agent integration](https://mini-swe-agent.com/latest/usage/swebench/) and
[SWE-bench 4.1.0 package](https://pypi.org/project/swebench/4.1.0/).

## Setup

Install the optional Python tools separately from the published JavaScript package:

```sh
uv venv --python 3.12 evaluations/external/.venv
uv pip sync --python evaluations/external/.venv/bin/python evaluations/external/requirements.lock
export ZHIVEX_SWEBENCH_PYTHON="$PWD/evaluations/external/.venv/bin/python"
```

Docker must be available. The images are Linux AMD64; an ARM host uses emulation,
which is recorded as a limitation of local timing. On macOS, ensure Docker Desktop's
credential helper is on PATH when pulling public images. Preparation can download
several gigabytes per task. It does not send model requests.

```sh
bun run benchmark:swebench prepare --output results/swebench/prepared --count 5
bun run benchmark:swebench preflight --prepared results/swebench/prepared
bun --env-file=.env run benchmark:swebench run \
  --prepared results/swebench/prepared \
  --output results/swebench/comparison --live
bun run benchmark:swebench report results/swebench/comparison
```

Every preparation/comparison output directory must be new. Failed attempts remain
separate. The default matrix is five seeded tasks, two candidates and one repetition;
`run` also caps the matrix at ten cases unless `--max-runs` explicitly increases it.
Do not choose replacements based on which agent succeeds. To expand, prepare a new
selection and exclude all development/pilot tasks from the confirmatory holdout.

## Identity and isolation

Preparation freezes the dataset revision, selected full-task digest, model, limits,
package versions, original evaluator image IDs and derived candidate image IDs.
The candidate image adds Node 22 to the official per-task image and sets Python's
search path to `/workspace:/workspace/src:/testbed:/testbed/src`. This prioritizes
the Harness snapshot while preserving the control's `/testbed` checkout. Preflight
checks top-level checkout package origins with the script-directory shortcut
excluded; an editable installation pointing to the original image must not silently
replace the candidate under test. Older prepared images without this binding must
be rebuilt before another comparison. Both agents use
that identical derived image; grading uses the pinned original image in a fresh
container. The run manifest records source hashes as well as the Git commit, so
uncommitted implementations are distinguishable.

Some official images squash Git history. The source tree is checked against the
upstream base commit. Where image packaging changes executable bits, preparation
requires identical paths and blob hashes and allows only regular-file 0644/0755
mode differences; the count and both tree identities are recorded. Changes in file
type or content fail preparation. Repository state must initially be clean.

Agent requests include only the problem statement and public task identity. Gold
patches, hidden test patches, hidden test names and hints stay in a private dataset
file outside agent workspaces. Official grading applies its hidden tests after the
agent exits. Actual workspace diffs, including new files, are exported independently
of model claims. Modifications to protected test/configuration files disqualify a
repair; raw official correctness is retained separately as `officialResolved`.

The comparison intentionally preserves product differences: Zhivex uses its read-only
OCI root, writable `/workspace` snapshot, durable approvals and explicit host import;
mini uses upstream prompts/control loop with a writable `/testbed` container.
Both agent environments deny network and use equal CPU/memory limits. Zhivex's
operator is automated with zero human wait, so this does not measure human review UX.
Shell/tool inventories and tool-call limits differ and are disclosed in the manifest.
The same Responses API model, low reasoning effort, per-response output cap, step
limit and cumulative token ceilings are used. Cumulative ceilings are checked between
requests and can overshoot by one response. Provider retries are disabled for the pilot.

## Reports and boundaries

`report.json` and `report.md` count every planned task/repetition. Missing samples,
agent failures and grading failures remain visible. Resolution requires independent
grading and adherence to the protected-file policy. Empty patches count as unresolved
without claiming that tests ran. Durations include preparation of each run and grading;
agent and grading durations are also retained in samples.

Prices are not invented. To estimate USD consistently from measured usage, supply
`--prices INPUT CACHED_INPUT OUTPUT` as USD per million tokens, using verified prices
for the exact provider/model at run time. The manifest records the supplied rates.
Without rates or complete usage, cost stays `null`. Cost per solved problem includes
spend on unsuccessful attempts. Interrupted requests can have unknown billed usage.

Intervals resample tasks, averaging repetitions within each task first. Five tasks
are an integration pilot, not credible evidence of general superiority. Correctness
on SWE-bench is not a security evaluation. Safety, hostile repositories, human review
and long-session continuity need separate suites. No leaderboard submission is made.

Run `bun run benchmark:swebench:test` for offline contract regressions; those tests
need only Python's standard library and do not install the optional evaluator or
call a provider. The preparatory OCI check and official positive/negative controls
are separate integration evidence.

## Recorded pilot: 2026-09-08

The [sanitized baseline](../../benchmarks/baselines/external-pilot-2026-09-08.json)
records ten runs: five seeded tasks, one repetition, `gpt-5.6-luna` with low
reasoning. Mini-SWE-agent resolved **5/5**; Zhivex resolved **0/5**. No samples
were missing and the official grader reported no grading failures. Empty native
patches counted as unresolved without invoking hidden tests. Before the pilot,
the grader rejected a neutral patch and accepted the reference repair on the first
task; these controls did not call a model.

Zhivex returned `EXECUTION_FAILED` on one case and lost that run's model telemetry.
Three other failed cases recorded 152,643, 119,718 and 110,074 cumulative input
tokens against a 100,000-token ceiling; the exact terminal reasons were not
retained, so a causal diagnosis remains open. The fifth case completed with one
model response, no tool calls and no repair. Unknown counters are `null` in the
sanitized baseline, even where the raw driver emitted zero with `usageComplete:false`.
Costs remain unknown because no rates were supplied and one run lacks usage.

The next improvement cycle should preserve sanitized terminal reasons and partial
usage, investigate context growth and approval resumption, and reproduce the
no-tool completion. Reuse these five cases for debugging, then measure the updated
system on an untouched holdout. This pilot supports no general superiority claim.

Raw local evidence is under `results/swebench/comparison-2026-09-08-fixed/`;
it includes manifests, predictions, official logs and a verified source snapshot.
An earlier interrupted integration attempt is kept separately and is excluded
from this fixed matrix; its unknown billed usage is not treated as zero. Source
snapshotting and between-case source verification were automated in the runner
after this pilot; the baseline retains hashes of the code actually executed.
The pilot's hash list omitted the shared telemetry helper and CLI launcher; future
runs include both. The final driver also adds a checked OCI type narrowing in the
preflight only; the paid agent path is unchanged.

## Follow-up implementation and untouched selection

Preparation accepts repeatable `--exclude-manifest` arguments. The intermediate follow-up uses
seed `20260909` and excludes all five original pilot tasks. The final selection uses
seed `20260910` and excludes all ten tasks from both earlier cohorts. Selection stays fixed
across preparation failures. One official Astropy image changed `pyproject.toml`:
preparation restores only that file from its verified public base-commit Git blob,
records both blob hashes and the packaged image ID, builds one candidate image
for both agents, and rechecks every source entry. Arbitrary source differences
still fail. Official grading continues to use the original pinned evaluator image.

The native follow-up uses exact digest-bound replacements, smaller default reads
and searches, and compaction at 16 messages or 16,000 estimated tokens with two
recent messages retained. An outbound model projection represents synthetic
summaries as user context (compatible with the pinned Responses adapter) and omits
orphan tool observations left by an approval/compaction boundary. Durable history
is retained. Snapshot inventory now has the configured total OCI byte limit,
independent of the 1 MiB model file-read limit; large fixtures are copied intact.

The benchmark allows recovery from ordinary tool execution errors within its
existing error budget, while approval and environment denials remain enforced.
It treats successful approved `apply_environment_patch` as the terminal receipt;
it does not spend another model turn after submission. The official grader still
decides resolution. Mini retains its upstream submission loop. These are disclosed
product/supervisor differences, not identical tool inventories.

Telemetry retains observed completed steps across thrown failures, deduplicates
approval continuations by step index, and projects guardrail limits, HTTP status,
error class, fixed diagnostic hints and fingerprints. No raw error messages,
provider bodies or repository contents enter diagnostics. When usage is incomplete,
recorded counters are partial measurements and cannot establish a total cost.

## Correct cumulative usage after compaction

An offline three-response control exposed SDK 1.11.0 counting 500 input tokens
when three measured responses each contained 100. The output budget guard now
reconstructs direct usage from complete, unique recorded steps plus explicit
compactor usage before evaluating the existing ceilings. Missing or invalid
measurements retain conservative accounting; child usage remains with the existing
child-budget logic. The regression also verifies that genuinely exceeding a
350-token ceiling still fails.

The native benchmark additionally counts usage at the model transport boundary
and refuses another request once either cumulative ceiling is reached, independent
of SDK approval/checkpoint bookkeeping. Reported counters use that transport
measurement. The intermediate 2/5 versus 4/5 run retains the old accounting defect
and is not valid evidence of equal effective budgets. It remains preserved as an
immutable diagnostic attempt. The final cohort is separate and excludes its tasks.

## Historical final cohort result: 2026-09-08

The [final baseline](../../benchmarks/baselines/external-final-2026-09-08.json) records five previously unused tasks (seed `20260910`), one repetition, and the corrected transport budget. All ten cases were recorded; there were no grading failures. All 54 recorded source hashes matched the checkout and archived source snapshot after execution.

| Candidate | Resolved | Input tokens, all attempts | Output tokens, all attempts |
| --- | ---: | ---: | ---: |
| zhivex | 1/5 | 422,592 | 5,463 |
| mini-swe-agent | 2/5 | 331,554 | 8,746 |

Zhivex resolved `scikit-learn__scikit-learn-14141`. Three unresolved native cases reached the input budget; `scikit-learn__scikit-learn-10908` stopped at the enforced executable allowlist. Mini resolved both scikit-learn cases. No HTTP 400 or snapshot setup failure occurred in this final native cohort.

Validation: `bun run check` passed with 427 tests, including migrations, deterministic evaluations, MCP, real OCI smoke and the installed package smoke. All five final preflights passed. Costs remain unknown because no price rates were supplied.

This result does not show superiority over the external baseline. The cohorts differ, so comparing the original 0/5, intermediate 2/5 and final 1/5 is not an improvement estimate. The remaining measured bottlenecks are search/context consumption and choosing commands within the declared environment policy. The source/approval/compaction/accounting corrections remain separately reproducible.

## Latest Qwen development rerun: 2026-09-09

With Core 1.14.0 / Agents 1.4.0 and the combined harness improvements, the same
five-task Qwen cohort remained at Zhivex 0/5 versus mini-SWE-agent 2/5. SDK schema
recovery worked in two live observations, but four native attempts exhausted the
input budget and one failed with incomplete usage. No token-saving claim follows
from this run. See the [detailed analysis](MODEL_COMPARISON_2026-09-09.md#qwen-rerun-with-core-114-and-progress-controls)
and [sanitized baseline](../../benchmarks/baselines/external-qwen-sdk-114-progress-2026-09-09.json).

## Diagnostic candidates and shared policy

The native driver now selects the product `repair` profile. Its tool catalog
includes original-task recovery, working plans and audit inspection; instructions
are rendered from that catalog. Command output is bounded to 20000 bytes in this
variant. Freeze a new manifest/preflight before comparison: these changes are a
new variant, not another repetition of the historical SDK-1.14 matrix.

Before deleting private state, the driver captures the final OCI candidate with
content/mode digests. Candidate text is private evaluator input (UTF-8, at most
1 MiB/file and 2 MiB aggregate); capture errors remain explicit and cannot erase
the imported patch result. The runner builds a separate disposable checkout and
grades that candidate independently. Candidate predictions are stored separately
from imported/final predictions; only imported/final grading contributes to the
original safe-resolution metric. Missing capture is unknown. Candidate results
that alter protected test/configuration paths do not count as resolved.

Sanitized telemetry records requested tool names, typed failures, finish reasons,
usage completeness, model durations, first text/tool-call latency when available,
aggregate tool timings, approval wait times, observed repair stages, OCI phase
latencies and grading time. Stream first-token timing refers to the first SDK
text delta or assembled tool-call event, not necessarily the first network byte.
Stages are observations (e.g. edit request/completion), not proof of semantic
progress. Model prompts, source, verifier output and arbitrary error messages are
not copied into public sample diagnostics. No new live superiority claim follows
from the offline remediation suite; run ablations and a fresh repeated holdout.
