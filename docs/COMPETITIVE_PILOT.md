# Competitive pilot protocol (HU51)

This protocol governs the delegated SDK-reference experiment and its preserved campaigns. It is not a published market comparison.
The user may select participating tools and the comparison mode or explicitly delegate that choice. Freeze and document the selection before execution. HU45 must
supply certification evidence for the exact Harness candidate before the pilot.
Do not infer versions, model snapshots, endpoints, access or certification from
an installed CLI or a passing unit test.

## Predeclare the experiment

`scripts/acceptance/pilot-protocol.ts` reuses HU44's task IDs, fixture bytes and
revision. It does not create a competing task suite. A strict plan fixes:

- Tool names, exact versions, artifact and configuration digests.
- Provider, model, route and model settings for each participant.
- Common task subset, repetitions, token/step/tool/time limits and approval policy.
- Maximum attempts (1–3), retry on failure only and rotating participant order.
- A reference digest for the prior certification evidence.

`same-model-harness` requires identical model/provider/route/settings across
participants. `product` allows differences and cannot isolate the harness's
contribution. A tool without enforceable declared budgets needs a revised,
explicitly agreed experiment; do not declare limits enforced when they are not.
The deterministic rotation changes which participant runs first across tasks
and repetitions; it is not random assignment or statistical power.

Lock a plan before execution:

```sh
bun --no-env-file scripts/competitive-pilot.ts lock plan.json new-plan.lock.json
```

The lock contains the canonical plan digest, budget digest and execution schedule.
A digest binds bytes; it does not authenticate a participant, evaluator or the
certification report. Verify those sources operationally. The declaration must
be agreed before running. The delegated participants and their acquisition are
documented below; each campaign has its own locked plan.

## Collect all attempts

Adapters must execute HU44's protected independent oracle and write one
`competitivePilotAttemptSchema` row per attempt to an append-only, flushed JSONL
journal. Retain failed and blocked attempts. Bind every row to the plan, tool
artifact/configuration, model settings, budget and approval policy. Store raw
execution evidence privately and reference its digest; the normalized row has
no prompts, command arguments, credentials or free-form diagnostic messages.

Use null for absent time, tokens, cost or human-intervention counts. Record
scripted user corrections and automated approvals separately from real human
intervention. Complete token usage requires both input and output counts; cost
requires a pricing evidence digest and remains an estimate, not an invoice.
The declared timeout covers the measured attempt. Success exceeding a reported
budget is rejected. Missing budget measurements make budget evidence incomplete.

The existing HU44 Harness runner supplies fixtures and independent checks; its
historical reports cannot simply be relabelled as a comparative campaign. The live adapters below acquire new
observations for the agreed technical reference. Protocol unit tests use fictional
participants, never results attributed to a real competitor.

## Summarize without erasing failures

```sh
bun --no-env-file scripts/competitive-pilot.ts summarize plan.json attempts.jsonl new-summary.json
```

Both commands operate offline and refuse to overwrite output. The summary retains
all normalized rows, planned denominators, missing cells, unfinished retries,
first-attempt success, recovery, blocked attempts, and available time/cost/usage
and intervention measurements. It rejects mixed artifact/configuration/model
identities, duplicate or skipped attempt numbers, out-of-order cells, and retries
after success or blockage.

A complete journal is not necessarily a successful campaign. Partial sums are
labelled with reported counts and completeness; they must not be described as
full costs. Use per-participant metrics and paired task observations when reporting.
Do not extrapolate superiority from this small sample or recommend repository-map
work without a demonstrated failure mode. Campaign reports in `docs/reports/HAR_HU_51_*` preserve observed results and
limitations separately from this reusable protocol. The user delegated experiment
selection; release publication remains a separate decision.

## Controlled SDK-reference acquisition

`competitive-pilot-live.ts` implements the delegated same-model experiment for
an explicit Anthropic model fixed in the plan. The first campaign used
`claude-sonnet-5`; subsequent tests requested by the user use `claude-sonnet-5-5`.
Evidence from different models stays in separate campaigns. The comparison is with a small direct-SDK reference
agent implemented for this experiment, not with a commercial product. The
reference has file reads/listing, digest-checked approved writes, approved checks,
SDK file persistence, cancellation and deterministic directive compaction. The
Harness participant uses the certified installed artifact and its own tools,
instructions, SQLite persistence and context policy. These differences are the
subject of the experiment, so success does not imply market superiority.

Both participants obtain the same model from the installed Harness provider
registry, including its signed Anthropic continuation normalization. The reference
still runs the direct SDK Agent and its own tools; it shares only this transport
adapter. Passing a raw SDK model through `modelInstance` bypassed normalization
in the first campaign and invalidated that campaign as a quality comparison.

Both participants receive the unchanged HU44 fixtures and protected independent
oracles. The evaluator permits only edits to fixture implementation paths and the
exact fixture check command. It verifies no mutation before approval or after
cancellation. `compaction-restart` closes the session and reconstructs it from
its durable store within the case worker; this comparison does not simulate
process death at that boundary. HU45 separately supplies process-restart evidence.
Each full case runs in a fresh worker and disposable workspace.
The revised restart setup uses an eight-message threshold and retains two recent
messages for both agents. Nine synthetic prior/current messages force initial
compaction. The earlier four-message threshold could not fit an indivisible
multi-call approval group plus the summary; that campaign is retained. Every
restart case must still prove compaction and successful reopen.

A shared meter spans every approval, reopen and correction run. It counts model
requests as steps and requested tool calls as tool calls, applies the remaining
output cap, uses a conservative input admission estimate, and checks reported
cumulative usage afterward. Input estimates are not exact provider tokenization;
a response can reveal an overrun, which fails the case and stops further work.
This is not a guarantee of a hard billing cap. Unknown usage fails closed. The
150-second task deadline uses abort propagation; the worker has an additional
one-second termination grace. A timeout/missing worker observation records null
counters, never manufactured zeros. Reported duration measures the case from
fixture setup through cleanup, excluding module startup; outer duration is also
retained in case evidence. Automated approvals/corrections use reported-count,
total and completeness summaries, like other nullable measurements.

Prepare without provider calls, then execute the fixed schedule:

```sh
bun --no-env-file scripts/competitive-pilot-live.ts prepare candidate.tgz /absolute/installed/dist certification.json /absolute/new-campaign claude-sonnet-5-5
ZHIVEX_HARNESS_LIVE=1 bun scripts/competitive-pilot-live.ts run /absolute/new-campaign
```

Preparation requires certification evidence for the exact selected model.
Preparation compares every installed dist file with the selected tarball and
binds the source files, direct SDK dist files in both the evaluator and installed
consumer (requiring equal versions and bytes), lockfile, model settings and prior
certification evidence. Before each case, the runner verifies that inventory.
It rotates participants, executes all 42 cases with one attempt each, flushes an
append-only journal after each case and refuses to overwrite prior campaigns.
SDK-internal transient retry defaults remain part of the fixed model settings;
one attempt means one whole case, not necessarily one HTTP request. Costs remain
null without pricing evidence. Failed cases remain in the denominator and no
adapter is tuned after seeing results within that campaign.

## Context-efficiency follow-up

The follow-up keeps Sonnet 5.5, the same fixtures, oracle, approvals, case-wide
budgets and 42-case schedule. It changes the Harness candidate and adds numeric
per-request evidence for both participants: serialized context characters by
role/tool definitions, conservative admission estimate, admission/completion,
reported input/output and cached input tokens. Missing cache usage remains null.
No prompt, tool argument or result text is retained in these measurements.
Instrumentation and its dependencies are included in the frozen input inventory.
Previous campaigns remain separate; instrumentation was not present in their
observations, so component-level before/after attribution cannot be invented.

The runtime advertises common tools first and makes additional schemas available
through `discover_tools`. The complete execution catalog retains its host policy,
approval metadata and original executors. Discovery does not authorize execution.
An explicit host catalog without `discover_tools` remains fully advertised.
Compaction estimates the selected schemas, including the discovery index, and
continues reserving space relative to the remaining runtime budget. The pilot's
case-wide meter additionally spans fresh correction runs; compaction never resets
that meter or refunds already reported usage.

Long successful check/search/dependency/diff results may be projected to a short
excerpt with a digest reference, exit status and an explicit partial-evidence
notice. Projection is used only when the original can be retrieved from the exact
current durable run. `read_tool_result` pages the original in 4,000-character
slices. Mutation receipts, failed tool calls and evidence absent from that run
remain intact; original persisted messages and tool results are not rewritten.
The feature reuses durable evidence rather than creating workspace-readable log
files. Retention of the source evidence is still governed by the run store.

`runHarness` diagnostics include bounded `requestMeasurements` for the current
invocation (at most 128 rows, plus an omitted count). Estimates are not tokenizer
counts or invoices. Failed requests without terminal usage remain unknown. The
pilot records rejected admission separately and retains all attempts.
