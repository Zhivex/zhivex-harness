# Repair recovery: development diagnosis

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

**Correction implemented; live acceptance and GA still pending.**

Fingerprint `fe23962a75a1376aa486d886cd84986beba7daecf721dfdce7e3fc800f8ef82d`
from OpenAI failures in the RC14 holdout corresponds exactly to
`REPAIR_VERIFICATION_RETRIES_EXHAUSTED`. Historical evidence lacks verifier
stdout: it cannot attribute assertion failure to a specific cause
or establish that this correction will resolve all failed deliveries.

An independent regression reproduced a controller defect: after a failed
verification, each diagnostic command with a nonzero exit code
consumed another verification retry. Three diagnostics exhausted the limit even
without another verification attempt. Failed mutations also
consumed that counter.

Those events now retain the recovery obligation without incrementing the
verification counter. Actual verification attempts still increment it;
three actual failures still block the run. Approval is not removed and no
candidate is imported without successful verification. Step, token,
tool and recovery-command limits remain in force.

The SWE-bench evaluator was also corrected for the new OCI isolation:

- Candidate capture and preflight use the Harness scope.
- The parent retains the state directory until cleanup finishes, even
  if the driver process dies.
- Cleanup uses execution identity in validated metadata, not the public
  run ID hash. Regressions reject metadata from another run or directory.

Local validation: the diagnostic regression failed before the change and passed
afterward. All 38 focused tests pass; the full suite passed 529 tests, together
with contracts, types, migrations, evaluations, benchmarks and MCP. The full gate
stopped at `docker start failed` during the OCI smoke; that boundary must be repeated
without concurrent restoration/reproduction load.

Live reproduction uses `django__django-15851` as **development data**, never
as a fresh holdout, with limits and models from the previous manifest. The first
attempt ended before calling the model because the historical image had been
deleted. It was rebuilt from original digests using the saved Dockerfile.
The new attempt preserves source hashes and results in
`results/swebench/ga-recovery-development-2026-09-19-restored/` and finished: OpenAI completed and delivered a patch; Qwen retained a candidate without a
verifier and ended `REPAIR_INCOMPLETE`. The [sanitized evidence](evidence/ga-recovery-development-2026-09-19.json)
preserves both results.
A delivered patch does not equal official correctness: this diagnostic
attempt does not run the independent grader.

Before GA, recovery validation must still complete,
the candidate must be frozen, a fresh cohort and criteria predeclared, independent
grading executed and the representative matrix and release gates collected.

## Second adjustment and validation in progress

The Qwen case confirmed that registering a verifier before editing was only an
instruction. The OCI controller now rejects mutations without a concrete
verifier registered through `repair_plan`, before executing the tool.
A regression checks no write on rejection and execution after
plan registration. This does not certify the proposed command is sufficient:
approval and independent checking remain necessary.

After this adjustment, 530 tests and tooling types passed. The OCI smoke passed
on repeat without concurrent load. The development comparison with official
grading is running sequentially for OpenAI and Qwen, one repetition of the
case and a mini-SWE-agent control for each provider, with original limits and source
hashes frozen by the runner. Results in
`results/swebench/ga-recovery-graded-{openai,qwen}/`. This is neither a fresh holdout
nor GA approval; the result is detailed below.

## Official result and projected-budget correction

The preceding comparison finished without missing samples or grader failures.
Harness resolved 0/1 with OpenAI and 0/1 with Qwen; mini-SWE-agent resolved 1/1 with
each provider. OpenAI stopped at `WORK_TOKEN_BUDGET` before editing; Qwen
ended `REPAIR_INCOMPLETE`. [Complete sanitized evidence](evidence/ga-recovery-graded-development-2026-09-19.json).
These attempts are neither excluded nor presented as successful validation.

Another inconsistency was reproduced: budget calculates projected usage for
the next call, but the progress controller entered finalization only
based on already recorded usage. It could therefore stop after registering a plan
with a verifier, before using the reserve to produce the candidate.

That projection is now calculated first and focused finalization activates when
the next step reaches the threshold. Before a candidate exists, reserve
is enabled only with a concrete registered verifier. The total limit is unchanged;
global exploration and calls exceeding the total budget remain
blocked. The regression fails before the correction and passes afterward, including
rejection above the total limit. All 31 module tests pass.

A second development comparison is running in
`results/swebench/ga-recovery-graded-v2-{openai,qwen}/`, with the same task, limits,
models, control and official grading. Correct delivery must still be demonstrated
before freezing a fresh cohort; GA remains NO-GO.

## Second comparison and recovery obligation

The second comparison finished: Harness 0/1 and control 1/1 for both providers.
OpenAI failed with `ProviderToolCallError` and `incomplete_arguments`; that attempt
lacks complete accounting and cannot certify budget or delivery.
Qwen ended `REPAIR_INCOMPLETE` during recovery. Official grading passed
without errors and all attempts remain in the denominator.
[Sanitized evidence](evidence/ga-recovery-graded-v2-2026-09-19.json).

Another regression reproduced that during recovery the controller left tool
selection automatic despite a pending obligation.
It now requests a tool (`required`) when supported by the provider/mode;
Qwen modes with thinking restrictions retain compatibility.
A final response still neither authorizes import nor satisfies the obligation.
The test fails before and passes afterward; all 32 focused tests pass.

The next development series is fixed before observing results:
`ga-recovery-v3-{openai,qwen}`, same task and limits, three repetitions for each
agent/provider (12 samples including controls), official grading and preservation
of all failures. This is not a fresh holdout or a substitute for GA gates.

## Three-repetition result

Series v3 completed all 12 samples, without missing samples or grader failures:

| Provider | Harness | mini-SWE-agent control |
| --- | --- | --- |
| OpenAI | 1/3 correct deliveries | 3/3 |
| Qwen | 0/3 correct deliveries | 3/3 |

OpenAI had one verification failure and one incomplete-argument failure with
incomplete accounting. Qwen had two incomplete repairs and one input-budget
limit. [Complete evidence](evidence/ga-recovery-v3-2026-09-19.json).
These results maintain NO-GO and are not evidence from a fresh cohort.

An additional integrated regression confirms that with Qwen in Chat and thinking
off, `toolChoice: required` reaches the model after approval and verification
failure. The transport diagnostic ended at INPUT_TOKEN_BUDGET with
complete accounting: the first eleven requests lacked tool choice and
the last carried `required` with thinking off. This confirms it was sent, not
that the service respected it in the previous failure. The wrapper read only `max_tokens`;
Qwen uses `max_completion_tokens`, so the recorded null value does not prove
absence of a limit. No prompts, responses, arguments or keys were retained
in that trace.

The local tarball of commit `41bd1cb4ab8481a7413f096a0817f612fe9806fe` passed separate
installation on Node 22.13.0 and Node 24.0.0 for macOS arm64.
[Consumer evidence](evidence/ga-node-consumers-2026-09-19.json). This does not
replace Linux or remote checks. Branch upload was rejected by automatic
permission review; the PR remains local and export awaits
explicit operator authorization.

## Verifier diagnostics for recovery

An additional regression reproduced that verification failure returned only
exit code and timeout to the agent. Both composite verifiers now preserve
redacted stdout/stderr bounded to 2048 characters per channel, retaining the
beginning and end when truncated. Content is marked as untrusted output;
approvals, limits and the prohibition on importing after failure are unchanged.
Pattern-based redaction does not necessarily remove arbitrary business
data printed by an approved command.

The regression failed before and passes afterward. The previous expectation of
complete omission in the internal result was updated: tests now distinguish agent
feedback, generic error message and exportable telemetry. The latter two
surfaces still omit diagnostics. 533 tests, runtime and tooling types,
preparation contracts and all five local security checks pass.
The live effectiveness of this correction has not yet been measured; v3 results
belong to the previous runtime and remain fully preserved.

[Local evidence of corrected diagnostics](evidence/ga-verifier-feedback-2026-09-19.json)
includes source hashes, suite, security probes and package installation.
Series v4 uses the same development task, one repetition per provider and
agent, preserving limits and grader from previous series. Its initial
startup failed before provider calls because credentials were not inherited;
the subsequent startup loads the local environment. This is not a fresh cohort.

## V4 result and completion without a candidate

The series completed all four samples with full grading: Harness 0/1 and control
1/1 for both providers. OpenAI failed with `incomplete_arguments`, without complete
accounting; Qwen ended `completed` without candidate or verification and the grader
marked it incorrect. Neither reached the verifier failure this series intended
to evaluate. [Complete sanitized evidence](evidence/ga-recovery-v4-2026-09-19.json).

A local regression reproduces completion after registering a plan with a
verifier but before editing. The correction requires a tool action in
compatible modes and rejects completion without delivery: result and checkpoint
become `failed` with `REPAIR_INCOMPLETE`. Budgets, approval and
grading criteria are unchanged. Live effectiveness remains pending.

An independent SSE fixture reproduces another limitation in OpenAI 0.13.2: the
adapter rejects incomplete `output_item.done` before consuming the terminal
event containing usage. `bun run scripts/validate-openai-stream-usage.ts`
exits with code 1: it simultaneously requires rejecting the incomplete call, emitting no
tools and preserving exact fixture counters. It uses no network
or real credentials. This does not demonstrate the live attempt had the same
terminal event, but explains a concrete path to incomplete accounting.
The limitation remains open; tokens are not estimated and retries
with unknown usage are not enabled.

Validation after the completion correction: 534 tests without failures,
runtime/tooling types, preparation contracts, documentation and package
installation passed. The separate accounting probe still fails and is not
counted as passing acceptance or hidden inside the green suite.

## V5 series and SDK proposal

The next development series retained task, limits and one repetition per
agent/provider. It completed four samples with full grading:
OpenAI Harness 1/1 and control 1/1; Qwen Harness 0/1 and control 1/1. Qwen produced
an edit, requested verification and executed a diagnostic command, but
ended failed without an imported patch. Both Harness attempts had complete
accounting. [Complete evidence](evidence/ga-recovery-v5-2026-09-19.json).
One OpenAI delivery on known data does not establish general improvement or
replace a fresh holdout. The release hold remains in force.

The registry still publishes OpenAI 0.13.2. An isolated SDK patch was prepared
in [the original SDK proposal](https://github.com/Zhivex/zhivex-harness/tree/c94a6c1cff9d6cbf0a3c66c05f7ce16df1d3cc38/upstream-fixes/openai-terminal-usage), outside the distributed
Harness package and without modifying the concurrent SDK checkout. It defers rejection of
an incomplete item until valid terminal usage can be read; it never emits the incomplete
call. Eleven regressions and isolated typecheck pass. The patch still
requires a typed public error contract, full SDK checks, review,
publication and consumption by the Harness budget. It does not fix the installed
dependency or constitute release evidence. The 0.13.2 probe remains red.

SDK patch update: the Core contract now includes optional `usage`,
validated, copied and frozen. An isolated copy of the base commit passed 2078 tests,
types, build and documentation with Bun 1.4.2, plus the installed-consumer
smoke. Only the corresponding `errors.d.ts` signature, tests, README
and changeset were updated. The concurrent SDK checkout was not modified.

The Harness budget consumes this field only on a `ProviderToolCallError`
from the correct provider, preserves the error and avoids double counting after
a finish. Missing or invalid usage or usage from an unrecognized error remains
unknown. 543 tests and the installed package pass. Integration with local
tarballs of the corrected SDK preserved 12 input and 8 output tokens without executing
tools and with the run still failed. Identities are in the patch evidence.
The published adapter remains 0.13.2 without the correction; SDK integration,
review and publication, dependency update and candidate certification remain pending.

## Bounded continuation after premature completion

An independent regression demonstrates the controller can recover a normal
model completion that still leaves a repair pending. The
application requests `read_task` once through ordinary gates,
preserves actual usage from that response and offers the original task to the model
again. The counter persists and does not reset on resume. The reminder
does not authorize edits, increase budgets or extend the two verifier-selection
requests. Errors, cancellation, output limits or unknown usage
do not activate it; normal stream closure is awaited to avoid
continuing after a late error.

Regressions cover continuation to approved editing/verification,
rejection of a second premature completion, counter restoration, exact usage
and limits. 551 tests, types and contracts pass. Series v6 runs one
Qwen repetition and its control on the same development task, without changing
limits or grader. Its result is not a fresh holdout.

Series v6 finished: Harness 0/1, control 1/1, complete grading and accounting.
Harness exhausted WORK_TOKEN_BUDGET after attempting to edit without a plan;
the mutation did not execute and the next turn read files again. There was no
candidate or verification, so this attempt does not measure the effectiveness of the
premature-completion reminder. It is fully preserved as a failure.
[V6 evidence](evidence/ga-recovery-v6-2026-09-19.json) and
[reminder regressions](evidence/ga-completion-reminder-2026-09-19.json).
The next boundary is the transition from REPAIR_PLAN_REQUIRED to a valid
plan, preserving budgets and the prohibition on editing without a verifier.

## Transition from editing without a plan

The regression failed before and passed afterward: rejecting an edit without a verifier
now persists `planRequired`. At most the next two attempts offer
`repair_plan` and `read_task`; an execution guard prevents bypassing the restricted
catalog. The limit persists on resume and neither opens finalization reserve nor
increases budgets. Only a valid verifier removes the obligation;
editing and verification retain normal approvals.

An integrated test reproduces rejection, planning, editing and approved
verification through delivery. Series v7 measures this variant on the same Qwen
development task, with one repetition and control, preserving limits and grader.

Series v7 finished with Harness 0/1 and control 1/1, no missing samples or grader
failures, and complete accounting. Harness consumed 94,008 input tokens in
13 calls and the next preflight reached INPUT_TOKEN_BUDGET. It registered a
plan at turn 9; the next three attempts were rejected with
REPAIR_PLAN_SCOPE and exploration then repeated. Codes are
identified by comparing fingerprints with constant runtime messages.
There was no edit attempt: this sample does not exercise the new transition or
establish live effectiveness. [V7 evidence](evidence/ga-recovery-v7-2026-09-19.json).

Local validation of this variant passed 554 tests, types, contracts, docs and
installed package. [Hashes and evidence boundary](evidence/ga-plan-transition-2026-09-19.json).
The SDK patch also landed on local branch `feat/ga-terminal-usage`, commit
`989ba33`, with normal history from the base commit and without modifying the concurrent
checkout. Its eight files match the validated copy byte for byte.
No push or publication occurred; export authorization remains pending.

## Persistent plan-scope context

An independent regression found that the model's working projection
omitted paths that the progress controller persisted and restricted. After
restoring state with compacted history, that projection did not recover
allowed files. It now retrieves normalized paths and remaining finalization
read/command quotas directly from the controller. Querying this
view neither activates finalization nor changes limits; out-of-plan paths remain
rejected. Harness integration also verifies paths reach
subsequent actual turns of the simulated model.

555 tests, types, contracts and installed package pass. The snapshot was reviewed
and regenerated: transitive hashes of `runHarness` and `HarnessRunOptions` changed
because diagnostics reference the controller type; public statistics
fields remain unchanged. Series v8 measures one Qwen repetition and control
with the same budget and grader. The omission is not assigned causal responsibility
for previous live failures without further evidence.

Series v8 finished with Harness 0/1 due to WORK_TOKEN_BUDGET and control 1/1.
Accounting and grading complete; the failure is not discarded and regressions
do not establish live effectiveness. [V8 evidence](evidence/ga-recovery-v8-2026-09-19.json)
and [hash-bound local validation](evidence/ga-working-context-2026-09-19.json).
The next diagnosis must isolate catalog/context effects before
adding new rules. A diagnostic variant will not replace the product
profile or count as GA acceptance.

## Reduced-catalog diagnosis

The isolated five-tool variant, predeclared in
[the plan](evidence/ga-catalog-ablation-plan-2026-09-19.json), finished with Harness
0/1 and control 1/1; grading and accounting complete. Harness consumed 41,620
input and 680 output tokens in nine calls. After compaction, it requested
an unregistered tool and ended with EXECUTION_FAILED. Compaction is not assigned
causal responsibility based on this single sample.

Both samples, report and source identity are preserved in
[the evidence](evidence/ga-catalog-ablation-2026-09-19.json). Against baseline
v8 only the driver changed: catalog and instructions rendered together.
The already available shell uses its own quotas; these are not the same executed paths
as native reads. The variant does not modify the product profile or
count as GA acceptance. This result justifies neither promoting the reduced
catalog nor claiming catalog size explains previous failures.

Inspection of the installed SDK and a transport regression rule out
deterministic catalog or system-instruction loss during ordinary
compaction: five requests retain both elements identically,
with more than one intervening compaction. All 13 tests in
`tests/sdk-compaction.test.ts` and tooling types pass. This test uses a simulated
model and does not itself explain live selection of an unregistered
tool; no speculative runtime change was introduced. The next
investigation needs evidence of the effective catalog at the provider
boundary, preserving telemetry policy without prompts or secrets.

The driver now instruments the adapter input boundary, inside controller
and budget middleware. `modelCatalog` preserves per call
the local names offered and, for each returned call, whether it was offered and
belongs to the driver registry. External names are replaced with
`other-tool`; arguments, schemas, messages and raw errors are not saved.
Evidence is limited to 100 requests and 64 returned calls per request,
with explicit omission counters. An interruption preserves
`completed: false` and does not modify the error or events.

12 driver/observer tests and tooling types pass. The ordering test
demonstrates observation of the policy-restricted catalog, not just the initial one.
This measures the neutral contract received by the adapter; it does not capture HTTP
bytes or prove which catalog the remote service saw. Synthetic controller
calls do not reach the adapter and are outside this measurement. There is still
no new live sample with this instrumentation; neither a cause for the
previous failure nor improved delivery is claimed.

The next sample, with full catalog and adapter observation, was
[predeclared](evidence/ga-catalog-observed-plan-2026-09-19.json), but **did not
start**: automatic permission review rejected external transmission because
specific authorization for content and destination was absent. Permission was requested
for the public case, evaluation-repository fragments and Harness instructions
to international Qwen, with one execution per candidate and original
limits. No alternate route was attempted.
[Separate live-evidence status](evidence/ga-catalog-observed-status-2026-09-19.json).
Combined local observation, compaction and driver validation passes 25 tests.

## Integration of the published SDK correction

After operator confirmation, a public `bun info` query verifies
Core 1.22.0, OpenAI 0.13.3 and Qwen 0.14.3. Harness now pins these versions
in package.json and bun.lock, including the Core override. Agents 1.8.0,
Gemini 0.12.1 and Meta 0.2.6 remain the queried versions. Batch
documentation and its exact check were updated; previous accounts
of OpenAI 0.13.2 are preserved as historical evidence.

The `validate-openai-stream-usage.ts` probe passes with the published package:
incomplete_arguments error, zero emitted tool calls and preserved
12/8 usage. It uses no provider network. 559 tests, runtime
and tooling types, build and installed-tarball smoke pass. The first smoke
attempt failed with EPERM on the temporary directory; the repeat with permissions
finished successfully. This closes the local-patch dependency for this acceptance,
not SDK provenance or new live certification by itself.

Pending Qwen authorization and Harness push authorization remain
independent boundaries. Confirmation of SDK publication was not treated
as authorization for those operations. GA remains NO-GO due to pending
reliable delivery and final certification.

Integrated acceptance also passes with workspace `runHarness` and the registry
adapter: the run fails without executing tools and accounts for
12 input and 8 output tokens, with usageComplete=true. It was added
as an automatic regression in `tests/model-budget-error-usage.test.ts`; its
10 cases and tooling types pass. The test injects local SSE without
provider calls. [Versions, hashes and limits](evidence/ga-published-sdk-2026-09-19.json).

## Authorized Qwen test with published dependencies

After explicit authorization, the full-catalog sample finished with
Harness 0/1 and mini-SWE-agent 1/1, complete grading and accounting. Harness
consumed 64,624 input and 915 output tokens in nine calls; the control
20,189 and 597 in eight. Harness ended at WORK_TOKEN_BUDGET, without a candidate
or verification. All nine requests retained 13 tools and one
system message; every returned call was offered and registered.
There were no observation omissions. This sample does not reproduce the previous
unknown-tool failure or demonstrate the cause of that historical failure.

The [complete sanitized evidence](evidence/ga-catalog-observed-2026-09-19.json) is preserved.
Combined dependency and observation changes prevent attributing differences to
a single variable. This is a known development task, not holdout or GA
acceptance. Limits and grader were unchanged. Qwen test authorization does not
extend to Harness push or publication.

The latest error fingerprint exactly matches the constant message
REPAIR_PLAN_REQUIRED: the model attempted an edit before registering the
verifier. The edit was rejected and the next turn blocked by
the work budget. The boundary to investigate is late planning
and recovery reserve; this evidence does not justify removing the
verification precondition or expanding limits to obtain a pass.

## Reserve to recover an edit rejected without a plan

The observed transition was reproduced without network: after rejecting an edit without
a verifier, the controller offered only repair_plan/read_task, but the budget
did not consider that obligation finalization. With 70% consumed, the call
failed before plan registration. The new regression failed before the
fix and passes afterward, including state restoration.

The planRequired obligation now enables the existing reserve for both
restricted planning attempts. The edit prohibition,
durable attempt limit and total token ceiling remain; a
second test confirms rejection at that ceiling. The policy fingerprint
advances to repair-v3-reserved-plan-recovery to distinguish checkpoints
from the previous contract. Benchmark limits were not increased.

562 tests pass after the reserve correction, as do types. This acceptance
is deterministic: it does not yet demonstrate improved live delivery.

The Qwen repeat with the correction finished: Harness 0/1 and control 1/1,
complete grading and accounting. Harness consumed 22,916 input and
949 output tokens in five calls. It attempted editing without a plan on turn three;
both explicit-selection turns offered repair_plan/read_task but
returned no calls from the adapter. The read_task observed on turn four
is the controller's synthetic reminder, not a Qwen call.
There was no candidate or verification. Failure occurred before reaching
reserve, so this sample does not evaluate its live effectiveness.
[Complete sanitized evidence](evidence/ga-plan-reserve-2026-09-19.json).

A new network-free test checks the Chat body serialized by Qwen 0.14.3
with the real controller: tool_choice explicitly selects repair_plan,
enable_thinking=false and the catalog contains only repair_plan/read_task.
The test and tooling types pass. This verifies local serialization;
it neither establishes historical live-request bytes nor identifies the
cause of missing calls in the remote response. Verification was not relaxed
and neither attempts nor budgets were increased.

## Qwen call loss when finishing with stop

A minimal live diagnostic with a synthetic fixture isolated a difference between
service and adapter. With explicit repair_plan selection, the service returned
25 tool_calls fragments and finish_reason=stop; Qwen 0.14.3 emitted zero calls.
With required selection, it returned 24 fragments and finish_reason=tool_calls, and the
adapter did emit repair_plan. No tool executed.
[Sanitized evidence](evidence/ga-qwen-tool-choice-2026-09-19.json).

Adapter inspection confirms it flushes buffers only when the reason
is tool_calls. `bun run scripts/validate-qwen-terminal-tool-call.ts` reproduces
loss without network using complete JSON and terminal stop: exit 1, zero calls, preserved
12/8 usage. This is an adapter defect; correction and validation
that length, truncated streams and invalid arguments never enable execution remain pending.
Benchmark response bytes are not inferred from the fixture.

The correction is prepared on local SDK branch
`feat/qwen-terminal-tool-calls`, based on the post-release commit
identified in [the SDK PR](https://github.com/Zhivex/zhivex-ai-sdk/pull/103).
209 Qwen tests, 2,424 SDK tests, types, docs and build pass. The compiled adapter
passes the fixture that fails in Qwen 0.14.3: one emitted call, normalized
tool-calls finish and 12/8 usage. The patch validates the entire batch before
emitting effects; truncated or invalid cases are rejected. It includes a changeset and
minimum Core 1.22.0. It is neither published nor installed in Harness; no
push occurred. Local-build testing does not yet establish the published package.

The Qwen correction landed in local SDK commit `35e2bb4`. Installed-consumer smoke
passed (51 entrypoints and deterministic golden path with Bun
1.4.2). The synthetic live diagnostic with the compiled adapter now recovers
repair_plan both with explicit selection and terminal stop and with required and
terminal tool_calls, preserving usage.
[Subsequent evidence](evidence/ga-qwen-tool-choice-patched-2026-09-19.json).
It executed no tools and evaluated no repair; published-package integration
and repeated Harness acceptance remain pending. No push or publication occurred.

## Complete repair with corrected Qwen tarball

An isolated Harness copy installed the local tarball built from SDK commit
35e2bb4, preserving catalog, policy, task, limits and grader. Frozen source
hashes differ from baseline only in package.json and
bun.lock; the tarball SHA-256 is bound to plan and result.

Result: **Harness 1/1 and control 1/1**, complete grading and accounting.
Harness registered a plan, verified and imported the patch, and passed the independent
evaluator with 71,480 input and 1,252 output tokens. The control
consumed 19,344 and 545. All previous samples and failures are preserved.
[Evidence](evidence/ga-qwen-patched-package-2026-09-19.json).

This is one known development task and a local package with the same
version number as the published one, distinguished by hash; it is neither
registry certification, holdout nor statistical reliability evidence.
Main Harness still pins published Qwen 0.14.3. The next gate
is reviewing/publishing the SDK correction, integrating it by version and verifying the
representative cohort and holdout with the final candidate. No push occurred and
the ledger was not promoted to GA.

Final review added a regression for an explicit late provider error:
an already complete batch must not emit if that error arrives afterward. It failed before and
passed afterward. Local SDK commit `c850ae0` rejects it while preserving reported usage
without propagating raw details. 2,425 tests, types, docs, build and offline
acceptance of the compiled adapter pass. Previous live and consumer evidence
remains bound to `35e2bb4`; it is not attributed to the new commit. Patch and
PR text were updated; no push occurred.

Installed-consumer smoke was repeated and passed on final SDK commit
c850ae0 (51 entrypoints, Bun 1.4.2). Live evidence remains bound to the
previous commit. Specific authorization to upload the SDK branch
and open a PR was requested; it remains pending. The Qwen patch is unpublished and
the final Harness candidate cannot be certified against that published version.

With explicit operator authorization, version-packages ran: Qwen
0.14.4 and changelog prepared, no Core/SDK bump. Main was incorporated, resolving
only a range-gate comment, and 2,425 tests, types,
docs, build and installed consumers (51 entrypoints) passed again. The branch was uploaded and
[PR #103](https://github.com/Zhivex/zhivex-ai-sdk/pull/103) opened
without draft, head e4cc9eb3e8218b604f58eccc3a8830f24e9fa71b. CI and CodeQL were
running when checked. No merge or publication occurred.

## Published Qwen integration and new sample

PR #103 was merged externally. CI, CodeQL and Node consumers passed;
provider conformance provenance was skipped. Release
[35477096556](https://github.com/Zhivex/zhivex-ai-sdk/actions/runs/35477096556)
finished successfully and the registry publishes Qwen 0.14.4. Harness now pins that
version, including documentation and the batch gate. Offline terminal-stop acceptance
passes against the installed package. 563 tests, types,
docs, preparation contract and installed Harness package smoke pass.

The new live comparison produced **Harness 0/1 and control 1/1**, with complete grading and
accounting. Harness ended completed after five calls, without plan,
candidate, verification or import; the grader rejected delivery. It consumed
32,073 input and 281 output tokens. The control resolved with 26,718 and 820.
[Published evidence](evidence/ga-qwen-published-2026-09-19.json).

The previous local-tarball success is preserved without replacing this failure.
The adapter defect is corrected, but a Harness boundary remains:
the current obligation arises only upon plan registration or attempted/completed
editing; early completion from exploration can remain completed
without delivering a repair. An explicit delivery contract is required
for tasks demanding it, while preserving legitimate inspection without editing.
No GA or dependency-caused variation is claimed.

## Explicit verified-delivery contract

Added requireVerifiedDelivery, false by default and valid only with the
repair profile. When enabled, the obligation arises before the first plan or edit;
completion from exploration cannot remain completed without verified delivery.
It persists in the controller and binds to the run fingerprint. It does not itself open
reserve or add approvals, attempts or budget. The existing one-time reminder
and verification obligation remain. The SWE-bench driver
enables it because its contract requires repair and import. Inspection without
editing remains available by leaving it false.

The regression failed before and passes afterward: output and checkpoint become failed
when the model finishes without repair, including preservation of the obligation when
restoring with default options. 566 suite tests and an additional
validation/fingerprint test pass; all four focused tests, types, docs,
contracts and installed package pass. The signature snapshot was regenerated for the
new public option and its transitive types.
[Hash-bound evidence](evidence/ga-required-delivery-2026-09-19.json).
This eliminates false completed status; it does not yet demonstrate better live resolution.

The required-delivery comparison finished with **Harness 0/1 and control
1/1**, complete grading and accounting. Harness failed with
INPUT_TOKEN_BUDGET after 96,896 input and 1,330 output tokens in thirteen
billed calls. It registered a plan, attempted editing and verification, but
verification errored and recovery did not complete. Two reads were
rejected with REPAIR_PLAN_SCOPE and a new edit with REPAIR_PLAN_REQUIRED.
The control resolved with 16,988 input and 544 output tokens.
[Complete sanitized evidence](evidence/ga-required-delivery-live-2026-09-19.json).

This sample did not end with a final response from exploration: it does not causally
prove effectiveness of the new gate, though it correctly preserves failure.
The deterministic regression remains evidence of closing false
completed status. The initial verification error has only a generic fingerprint
in this telemetry; its cause is not attributed without further evidence. The next
diagnosis must distinguish command failure, patch-drift rejection and
import error to focus recovery without publishing raw logs.

### Offline verifier diagnosis and feedback regression

The required-delivery development run failed its verifier with exit code 1. The fixed `TerminalVerificationFailure` message hashes exactly to `d22955ecb1810cd7e960e732636eec570e04ab3b19eab276ebf23e2096a3c941`. Inspection of the full turn 9 also confirms existing structured evidence: exit 1, no timeout, failed verification, and 436 output characters. A later null-output projection does not establish missing model feedback. The underlying reason for verifier failure remains unknown; this is not evidence of a defective repair versus a defective verifier or environment.

Telemetry now recognizes only the exact fixed failure template and emits a bounded numeric exit code even for message-only serialized exceptions. It exports no raw message or verifier output. A regression checks strict and repair recovery at the next model request boundary, in addition to persisted state: bounded verifier diagnostics reach the model while external telemetry omits their content. All 18 focused tests and runtime/tooling typechecks passed. No new provider call, benchmark rerun, or change to prior failed samples was made. Evidence: `docs/reports/evidence/ga-verifier-failure-identification-2026-09-19.json`. GA remains unproven.

### Validation follow-up and one bounded diagnostic pair

The complete local suite passed 568 tests across 68 files before the verifier-output marker projection was added. After that telemetry-only change, 19 focused tests and the tooling typecheck passed. Documentation, preparation contract and five local security probes passed. The contract still reports one open GA blocker. Source hashes and check boundaries are retained in `evidence/ga-local-validation-followup-2026-09-19.json`.

The predeclared `ga-verifier-hints` pair is complete: Harness 0/1 versus control 1/1, with complete usage and grading. Harness used 94,600 input / 1,580 output tokens and stopped at INPUT_TOKEN_BUDGET. Its verifier returned exit 1 without a timeout at turn 13; no allowed Python exception marker was observed. The control used 27,051 input / 673 output tokens. No repair, prompt, model or budget setting was changed for this run. There was no repeat after completion.

This result does not identify the cause of verifier failure. The model had already spent turns on a missing path, a tool-input schema error and two plan-scope rejections before the edit. These are observed costs, not proof of the verifier's cause. A further diagnosis needs the exact approved verifier and bounded local failure details at the execution boundary; widening exception-label guesses or repeating the same pair would be insufficient. The temporary run state was intentionally cleaned by the runner, so the previous raw failure output cannot be recovered from retained samples. Evidence: `evidence/ga-verifier-hints-plan-2026-09-19.json` and `evidence/ga-verifier-hints-live-2026-09-19.json`. This remains development evidence and does not satisfy representative or fresh-holdout acceptance.

### Private execution diagnosis: unavailable runner and incorrect candidate scope

A single predeclared Harness-only diagnostic retained at most three verifier failure records in a private local temporary directory. The driver used the same Qwen model and limits; no control or acceptance evaluation was claimed. It stopped at INPUT_TOKEN_BUDGET (92,923 input / 1,028 output tokens). The captured approved verifier used `python -m pytest`; Python reported that pytest was not installed. This directly establishes the verifier infrastructure failure for this diagnostic, not every previous sample. The benchmark prompt had recommended pytest without checking availability. That recommendation is now replaced by discovering the project runner and available dependencies, or using a self-contained assertion; no dependencies or budget limits were changed.

Retained environment metadata also reproduced a candidate-capture defect: the actual run was unscoped, but the final diagnostic capture acquired config.scope and therefore inspected a different, empty snapshot. Candidate capture now uses the actual state.runId and state.scope. A real filesystem/OCI-session regression demonstrates that the configuration scope is empty while the run scope contains its edit. Historical candidatePresent=false values therefore cannot prove absence of a candidate. Imported host patches and official task failures remain unchanged.

The private observer preserves approval metadata, original error identity and normal execution even if its callback throws. Its callback is disabled by default and does not add raw records to exported benchmark results. Thirteen focused tests and the tooling typecheck pass. Evidence: `evidence/ga-private-verifier-plan-2026-09-19.json` and `evidence/ga-private-verifier-root-cause-2026-09-19.json`. The retained private snapshot now permits offline candidate diagnosis without another model request. No live effectiveness claim is made for either correction.

### Retained candidate passes official grading without another model call

The corrected scope-aware capture recovered one updated file, `django/db/backends/postgresql/client.py`, from the prior private diagnostic. Capture validated the retained execution binding and content digests. The existing candidate exporter reconstructed the diff in a separate disposable checkout and verified its base digests; no protected files changed. The pinned official evaluator completed with `resolved: true` for patch SHA-256 `15989da845ac1f766848c5c2e153296d7eef926a752ec658548702ac0e028bc7`. No model request or provider credential was involved in this grading.

This distinguishes a correct retained repair from unsuccessful delivery: the original verifier required unavailable pytest, import did not succeed, and the original run remains failed at its input budget. It does not demonstrate that the corrected prompt now completes the entire live flow. Historical failed samples remain unchanged. The current complete local suite passes 571 tests across 70 files. Evidence: `evidence/ga-retained-candidate-grading-2026-09-19.json`. The next live check should test the corrected verifier-discovery instruction and successful verified import under the unchanged limits; GA representative and fresh-holdout gates remain open.

### Verifier-discovery instruction: complete matched pair, delivery still fails

The single predeclared `ga-verifier-discovery` pair completed with full grading and usage: Harness delivered 0/1 and control delivered 1/1. Harness consumed 95,888 input / 1,241 output tokens. The corrected capture now finds its candidate and the official evaluator resolves that candidate, but neither verifier succeeded (exit codes 1 and 2), no patch was imported, and the run reached INPUT_TOKEN_BUDGET. The discovery instruction alone therefore does not establish reliable verification and delivery. No further retry or budget increase was made.

The scope correction has direct live evidence; delivery remains blocked. The next improvement must address actual verifier selection/execution failures rather than treating a correct retained patch as successful delivery. Source-bound samples and the unchanged-budget plan are retained in `evidence/ga-verifier-discovery-live-2026-09-19.json` and `evidence/ga-verifier-discovery-plan-2026-09-19.json`. This result does not alter any earlier sample or satisfy GA acceptance.

The current installed-package smoke also passed for `@zhivex-ai/harness@1.0.0-rc.14` after the verifier-discovery pair. No package publication was performed.

### Python editable-install shadowing reproduced and fixed in candidate images

Offline execution of the documented Django runner exposed another environment defect: running `python tests/runtests.py dbshell --settings=test_sqlite --parallel=1` reported Django from `/testbed/django`, outside the mounted candidate. Its apparent pass did not verify the retained edit. The image's editable installation took precedence when Python used the nested script directory rather than the checkout root.

Derived candidate images now set `PYTHONPATH=/workspace:/workspace/src:/testbed:/testbed/src`; the image tag derivation includes this policy. Both candidates still receive the same image, and the control retains `/testbed` resolution. Native preflight checks top-level checkout package origins without relying on `-c`'s current-directory shortcut and fails closed on absent or shadowed checkout packages. Old prepared images must be rebuilt; old results remain immutable development evidence, not proof of candidate-bound verification.

The corrected image `sha256:4c8b7a320988313b8881a96f334a189bfd0d6fda47cc0219d648867ffe765b80` resolves Django from `/workspace` for Harness and `/testbed` for the control. The public runner now genuinely sees the candidate and fails one historical test expecting the old argument order (26 tests, 5 skips); that is distinct from infrastructure availability. A separate four-case assertion derived solely from the public issue rejects the old image's source origin, fails against the baseline under the corrected image, and passes against the retained candidate. No repository tests, evaluator tests or host source were changed.

Twelve focused tests, tooling typecheck, Python compilation and native OCI preflight pass. No model/provider request was made. Evidence: `evidence/ga-python-checkout-imports-2026-09-19.json`. The next live comparison must use the corrected pinned image; this offline validation does not prove reliable verified delivery.

### Corrected-image diagnostic stopped on unknown tool selection

One private Qwen run with the corrected image stopped on the first model turn after two unregistered tool calls (4,652 input / 97 output tokens, zero executions and approvals). No verifier ran, so this cannot establish delivery effectiveness for the image correction. No retry was made. The result is retained in `evidence/ga-python-origin-delivery-2026-09-19.json`. Relative to the previous private diagnostic both the verifier-discovery instruction and image differ; this is not a causal A/B claim.

Installed Core 1.22.0 already supports opt-in unknownToolMode `tool-result`, but repair mode enabled only argument-schema recovery. Repair now also returns unknown selections as structured errors while leaving strict mode unchanged. The run fingerprint changes to bind this policy. Tests cover successful correction, strict/explicit fail-fast behavior, the tool-error ceiling, preserved token accounting and approval required for a subsequent mutation. No unknown tool is registered, renamed or executed.

Validation after the selection-recovery change: 577 tests across 72 files pass, including five focused regressions. Runtime/tooling types, documentation and the preparation contract pass. Evidence: `evidence/ga-tool-selection-recovery-2026-09-19.json`. No live retry or GA acceptance claim was made.

### Corrected-image end-to-end delivery passes one development diagnostic

The predeclared single Qwen run at implementation commit `fbceb4f` completed in 7 recorded turns, with 8 tools and 2 approvals. It used 47,739 input / 860 output tokens under the unchanged limits. Verification exited 0, the governed import completed, and the independent pinned official evaluator resolved the actual host patch. The imported patch SHA-256 is `15989da845ac1f766848c5c2e153296d7eef926a752ec658548702ac0e028bc7`, matching the independently graded retained candidate. No protected files changed.

No unknown-tool error occurred in this successful run, so it validates the current bundle's delivery path rather than proving the causal live effect of unknown-tool recovery. That behavior remains supported by focused regressions. This is one known development instance, without a concurrent control; previous failed attempts stay failed. It is not GA acceptance, a reliability rate, or fresh holdout evidence. Further repetitions of this same case are closed; the next external evaluation should use a fresh predeclared cohort and freeze implementation throughout. Evidence: `evidence/ga-tool-selection-live-plan-2026-09-19.json` and `evidence/ga-tool-selection-live-2026-09-19.json`.

### Fresh five-task cohort: complete, no GA approval

The predeclared cohort excluded all 17 previously used task IDs, pinned five new tasks and their images, and passed all five native preflights before paid calls. The frozen implementation was `1886644`. All ten planned model runs and their independent grading completed; usage is complete and there are no missing rows or grading failures. No retries, replacements or source changes occurred during the cohort.

Harness resolved 0/5; mini-SWE-agent resolved 1/5 (Requests). Harness stopped before any plan/candidate in three Django cases at WORK_TOKEN_BUDGET, exhausted total input on Requests, and completed/imported Pylint without satisfying the independent evaluator. The candidate-only score was also 0/5. The comparative bootstrap interval is exploratory for only five tasks and does not support a broad accuracy or safety claim.

The input target was 100,000 for both, but enforcement differs: the control checks between calls and observed totals ranged from 100,223 to 107,327; Harness predicts the next request and reserves work capacity for closure. Actual consumed-token parity is therefore not claimed. Three Harness work-budget stops occurred after 57,786–62,053 input tokens with no repair plan, leaving a substantial unused closure reserve. The next implementation investigation is whether required-delivery runs transition into bounded planning before the work boundary rejects another call. This is a hypothesis to reproduce locally, not proof of a fix.

The fresh holdout is now complete and these five cases join the exclusion set for future fresh evaluation. Its results do not support GA approval. Preparation, plan and all sanitized samples are preserved in `evidence/ga-fresh-cohort-preparation-2026-09-19.json`, `evidence/ga-fresh-cohort-plan-2026-09-19.json`, and `evidence/ga-fresh-cohort-result-2026-09-19.json`. All protected release, representative and final security requirements remain unchanged.

### Work-budget boundary regression and bounded planning transition

The three fresh-cohort work-budget failures had no plan/candidate and no verifier attempt. A local middleware regression reproduced the transition defect: with 60% of input already consumed and a large current exploration catalogue, the next request exceeded the 70% work ceiling and failed before offering planning. The positive regression failed with WORK_TOKEN_BUDGET before the change; optional-delivery inspection retained its expected rejection.

Required-delivery OCI runs now estimate the current request, including the working-state projection, before the budget gate. If exploration would reach the work boundary and there is no verifier/candidate, the controller enters its existing durable planning obligation: only repair_plan/read_task, at most two attempts across resumes. The budget then estimates the narrowed request and enforces the unchanged total ceilings. Tests also cover the output work boundary, no calls after total input/output exhaustion, rejected exploration during planning, and persistence of attempt limits. No task-specific answer or verifier was injected.

An initial implementation exposed the estimator through the internal budget return type, which unnecessarily changed transitive declaration hashes. The estimator was moved to a standalone internal helper; the existing Stable signature snapshot remains unchanged and the contract check passes. The runtime fingerprint advances to bind the new scheduling behavior. The failed fresh cohort remains immutable evidence; no live retry has yet validated this change.

Final local validation: 584 tests across 72 files, runtime/tooling types, documentation, preparation contract and installed-package smoke pass. Stable signatures remain unchanged. Evidence: `evidence/ga-work-budget-planning-2026-09-19.json`. No live provider call was made for this change.

Continuation review reproduced two additional failures: registering the forced plan cleared the transient reserve eligibility before an edit, and an already registered plan prevented boundary activation. Required-delivery OCI work now durably enters closure reserve at the boundary, with or without an existing verifier. Missing verifiers still require bounded planning. Checkpoint restoration preserves reserve eligibility without replenishing usage; total-input exhaustion still prevents dispatch. Both regressions failed before this correction and pass after it. Reserve availability alone does not prove a successful repair.

### Work-boundary live development check: plan reached, delivery still fails

The predeclared single rerun selected django__django-10914, the first previous work-budget failure in manifest order. Implementation a6d6540, all source hashes, prepared image and original limits were frozen. Native preflight passed. One Qwen attempt consumed 93,522 input and 1,275 output tokens across nine model calls with complete usage. The observed progress records enteredClosure=true and planRecorded=true; the run then failed INPUT_TOKEN_BUDGET without an imported patch. Independent grading completed with empty-patch-no-solution / resolved=false.

This supports the narrow observation that the run could record a plan and continue beyond the prior work-budget stop, not that the change improves correctness. Subsequent calls requested environment shells and patch inspection; no deliverable was established. A local postprocessing helper initially rejected the empty patch, so grading was resumed from the stored terminal result without another model call. The failed attempt remains the sole attempt.

The fresh 0/5 holdout remains unchanged. Further investigation should examine whether the remaining context and tool sequence allow the planned repair and verification to finish inside the fixed total budget; another indiscriminate retry is not justified. Evidence: evidence/ga-work-boundary-live-plan-2026-09-19.json and evidence/ga-work-boundary-live-2026-09-19.json.

### Complete local release preparation check

At implementation a6d581a, bun run check completed with exit 0: 584 tests, both typechecks, documentation, preparation contract, historical migrations, deterministic evaluation, workspace/safe-fix benchmark checks, both MCP interoperability smokes, native OCI smoke and installed-package smoke. bun audit found no vulnerabilities among 35 packages; bun pm untrusted reported no untrusted dependencies with scripts. This is local evidence, not a protected release result.

The release-readiness script remains red: RC14 is intentionally Unreleased without a dated release heading, the check ran on the feature branch, and the evidence additions were uncommitted when checked. Do not date a release or mark these gates passing before the corresponding release action. The formal GA ledger additionally requires final representative evaluation, immutable publication/provenance and named artifact-bound human security review. Context analysis of the latest failed development run is retained separately; it does not justify changing acceptance criteria or an unmeasured runtime tuning.

Evidence: evidence/ga-complete-local-check-2026-09-19.json and evidence/ga-work-boundary-context-analysis-2026-09-19.json.
