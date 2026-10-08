# Minimum task authority (Experimental, unreleased)

The direct Code `/task` flow has one native writer: objective and exact scope,
bounded execution, interruption/resume, declared checks, fresh local review, and
an explicit human keep/revise decision. The task identifier owns the frozen token
and monetary policies across run identifiers, new turns, revise and restarts.
Ordinary runs keep their existing per-run policy and retry behavior. Web task
flows, review groups, parallel writers and new provider support are outside this
change.

## Durable admission and recovery

The SDK token coordinator is the sole token allocation authority. Primary,
tool-result continuation and semantic compaction requests reserve from that
owner before dispatch. Task middleware disables SDK retries and admits one
provider request per reservation. Full remaining input/total ceilings are held
because a local context estimate is not a billing bound. Confirmed usage settles
the reservation; incomplete outcomes retain it and close admission. A complete
late receipt still charges the owner. Thirty percent of the ceiling is reserved
for tool-free closure; verified repair also uses the frozen task ceiling and
confirmed consumption from earlier runs.

The task control record freezes limits and price policy, records run membership,
and holds an invocation marker until every admitted tool effect finishes. A
lease fences new requests, tools and checkpoints. SQLite triggers atomically
protect marker transitions and retention because the pinned SDK's save path
does not enforce `leaseOwnerId`. If a process crashes or its lease expires while
an invocation is pending, another process cannot take over, reset credit, or
silently clear that marker. This version has no automatic uncertain-outcome
reconciliation. A local abort requests cooperative stopping; it cannot prove
external cancellation or exactly-once execution of an arbitrary API.

Only the native SQLite host is supported. File/custom stores and non-native
execution backends cannot establish this authority. Legacy tasks without a
budget remain inspectable but cannot dispatch another model call. Task control
records and linked token ledgers resist ordinary cleanup, including direct SDK
SQLite deletion. Ordinary unrelated runs can still be pruned.

Logical JSON state backup validates task links but deliberately omits transport
monetary tables. Importing it into an empty host cannot resume a task and fails
closed with `USAGE_LEDGER_MISSING`. Preserve a consistent complete operations
database, including required SQLite journal state. Uncertain token usage or a
pending invocation also blocks logical backup. A token snapshot cannot replace
the monetary authority or prove that an external effect finished.

## Transport capability matrix

These contracts are verified against the installed pinned adapters using
synthetic HTTP and credentials in [transport tests](https://github.com/Zhivex/zhivex-harness/blob/11f4a038ca4f6d1d04985af135f792f712163930/tests/task-transport.test.ts)
and host admission tests, without live provider calls. They establish local
dispatch/cap behavior, not provider billing guarantees or model quality.

| Route | Direct guided task | Verified wire cap and dispatch boundary |
| --- | --- | --- |
| Built-in OpenAI (`@zhivex-ai/openai` 0.14.1) | Supported | Responses `max_output_tokens`; Chat `max_tokens` without reasoning or `max_completion_tokens` with reasoning; `maxRetries=0`, `maxProviderRequests=1` |
| Built-in Anthropic API key (`@zhivex-ai/anthropic` 0.13.2) | Supported | Messages `max_tokens`; non-refreshable built-in credentials; `maxRetries=0` |
| Built-in Gemini (`@zhivex-ai/gemini` 0.13.0) | Supported | `generationConfig.maxOutputTokens`; `maxRetries=0` |
| Built-in Vertex (`@zhivex-ai/vertex` 1.2.4) | Supported | `generationConfig.maxOutputTokens`; real ADC callback, synthetic credential source in tests; `maxRetries=0` |
| Qwen (`@zhivex-ai/qwen` 0.16.4) | Blocked as Code primary | Explicit Chat-mode middleware tested with capped `max_tokens`; Code has no explicit mode selector and Responses rejects `maxTokens` |
| Meta | Blocked | Harness continuation fetch can replay a 400 response outside SDK retry admission |
| Injected/custom adapters, refreshable Anthropic OAuth | Blocked | No vetted transport provenance; OAuth transport can replay a 401 after refresh outside ordinary retry admission |
| Mock | Offline tests only | Synthetic usage is never billing evidence |

The built-in factory marks vetted adapters with a private runtime symbol;
serialized model metadata cannot establish provenance. Task middleware checks
explicit Qwen Chat mode before downstream provider policy mutation. Both
generate and streaming requests, primary and compaction lanes, verify a single
503 dispatch and held unknown consumption. Separate tests verify ordinary
configured retries still dispatch twice.

Source boundaries: `src/runtime/config.ts` factory provenance,
`src/runtime/task-budget-host.ts` admission,
`src/runtime/task-budget.ts` request reservation,
`src/providers/providers.ts` API-key construction,
`src/providers/meta-continuation.ts` receipt replay, and pinned adapter files
`node_modules/@zhivex-ai/{openai,anthropic,gemini,vertex,qwen}/dist/index.js`.
Anthropic's `DirectAnthropicMessagesTransport` 401-refresh branch and Qwen's Responses
validation explain their unsupported cases. No SDK source or dependency version
is changed here.

To extend parity, a separately reviewed SDK contract must expose a durable
before-dispatch reservation/after-dispatch receipt hook for **every** internal
retry, OAuth refresh replay and continuation fallback, including aborted and
partial receipts; each hook must carry stable attempt identity and fenced
cancellation admission. Meta's harness wrapper must use that same hook. Qwen
also needs explicit mode/output-cap capability admission on the Code host.
SQLite SDK save should atomically enforce lease ownership. These are proposals,
not guarantees implemented by this PR.

The original PR187 assessment used Core 1.30.1/Agents 1.10.3. The HU70 integration uses main pins Core 1.31.0/Agents 1.11.0; the same store-boundary limitation remains. Cross-host takeover is outside the ratified topology; concurrent admissions within one writer host still require atomic reservations.
In `node_modules/@zhivex-ai/core/dist/agent-store/sqlite.js`, the `save(state,
saveOptions)` branch checks `expectedRevision` and calls `saveStatement.run`
inside `BEGIN IMMEDIATE`, but never reads `saveOptions.leaseOwnerId`. Revision
checks therefore accept a delayed save after lease takeover when the new owner
has not yet written a revision. This is an SDK contract gap, not generic lease
fencing supplied by Harness. The local triggers apply only to application task
invocation transitions and task draft INSERT/UPDATE records; unrelated SDK
checkpoints retain their published behavior.

[Task authority regressions](https://github.com/Zhivex/zhivex-harness/blob/11f4a038ca4f6d1d04985af135f792f712163930/tests/task-budget.test.ts) pause a task-root
clear save, transfer the lease without a revision write, and verify atomic
rejection. [Draft host regressions](https://github.com/Zhivex/zhivex-harness/blob/11f4a038ca4f6d1d04985af135f792f712163930/tests/task-budget-host.test.ts) cover both
first INSERT and existing UPDATE after expiry or takeover, while an ordinary
checkpoint with an unowned `leaseOwnerId` still writes. Draft logical import
uses only a transient lease within its exclusive import transaction, retains
active-destination-lease refusal, and leaves no lease after commit or rollback.
It does not restore the omitted monetary tables or grant task execution credit.

## Telemetry and local measurements

Bounded numeric telemetry records preparation milestones, context initialization,
primary model transports, separate semantic compaction transports, persistence,
tools, render observations and total wall time. `prepare-start` to `prepare-end`
covers task acceptance setup and budget-owner lookup/resume validation; invocation
lease admission and runtime context initialization follow that milestone.
The `context` spans measure scoped-context runtime initialization and, separately,
each request's pending discovery wait, scoped-file refresh, progress check and
instruction injection. They end before the model transport starts. They do not
cover full prompt tokenization or scoped discovery inside tool execution.
The `compaction` lane measures auxiliary model transport and consumption,
not deterministic summary assembly. The terminal renderer marks first visible text when
it actually writes; a host text event is a different timestamp. Overlapping
spans are not summed into total latency. Observer failures cannot suppress
mandatory audit/persistence failures. Payloads omit prompts, arguments, paths
and free-form errors.

On one M4/16 GiB machine, Bun 1.4.0, three alternating RC6/candidate trials with
the same 100,000-row foreign-scope fixture reduced median ledger summary time
from 4.4577 ms to 0.06429 ms. Empty-history median was 0.15417 ms versus
0.06558 ms. The compound index costs 55.47–56.56 ms to create and **9,048,064
additional SQLite allocated bytes** for the long-key fixture; reopening took
2.07–2.63 ms versus 0.99–1.51 ms on RC6. These local numbers do not establish
general workload speedups. Reproduce with
`bun scripts/benchmark-usage-ledger.ts --baseline-root /path/to/clean-rc6`.

Prepared activity statement reuse reduced the local 1.5 MiB retention median
from 0.89075 ms to 0.78838 ms; that roughly 11.5% observation does not satisfy a
30% critical-path improvement target. SQL predicates, transactions, retention
and mandatory errors are unchanged. No context pruning, batching or parallel
writers are introduced.

[Offline evaluation preparation](MINIMUM_OFFLINE_EVALS.md) freezes twelve
synthetic JS/TS tasks and a separate development split. Identical scripted RC6
and candidate runs pass the twelve oracle checks; empty patches pass none.
This validates fixture/runtime behavior only. Real private task selection,
independent human acceptance and an approved paid campaign remain necessary
before any model-quality, cost-per-accepted-result or benchmark claim.

## HAR-HU-70 integration delta

One task owns one frozen token coordinator and one transport monetary owner. Task revisions, new runs, explicit retries and restarts retain both identities and original policies. This experimental cut supports one native SQLite writer host; children are refused before dispatch rather than charged to independent pools. Review-group helpers are not evidence of a budgeted parent. Existing unsupported provider routes remain unsupported.

The task admission context reserves conservative input exposure, the output cap and the existing closure fraction before transport. The same frozen fraction protects the monetary work allowance when an explicit USD limit is configured. Closure can use the retained remainder; this is not a guarantee that any particular final answer fits it. A monetary refusal before dispatch settles only that proven undispatched token reservation to zero. Exceptions after dispatch retain unknown exposure. All requests, including auxiliary compaction, are classified in the same transport ledger; independent runs and cumulative SDK usage are never added again.

Inspection separates confirmed-call estimated USD, pending reservations, retained unknown exposure and late receipt counts. A complete late receipt is counted once and cannot reopen task admission. Partial or absent usage stays unknown; unknown estimates do not become zero. A missing/stale rate refuses monetary-limited dispatch; an unpriced non-monetary task reports unknown cost. Rates remain operator estimates, not invoices; cached/reasoning-rate specialization and the inherited explicit-cap correction are not new claims of this increment. External tool/service fees are not covered by this model-transport ledger.

The transport table gains additive category and late-receipt columns; existing rows read as legacy. Stable run statuses, signatures and the existing usage-summary JSON remain unchanged. The extended task inspection is Experimental and host-only; public web projection belongs to HAR73. No generic reconciliation UI is introduced: an unknown result remains held until an authoritative complete receipt is available, and a crashed invocation with unresolved effects remains blocked. A later authorized recovery design must not silently clear it.

Interactive chat retains no accumulated cap by default. To opt into a TASK budget while chat remains unlimited, include exact limits in the task brief:

```text
/task start {"goal":"Fix greeting punctuation","paths":["greeting.mjs"],"checks":["test"],"budget":{"inputTokens":60000,"outputTokens":8192,"totalTokens":68192}}
```

Without this explicit object on an unlimited host, creation fails with `TASK_BUDGET_FINITE_LIMITS_REQUIRED` before model dispatch. Existing explicitly bounded host configuration remains usable. Inspection/reopening reads the original task policy; changing host defaults does not mint credit. Monetary `/budget` configuration for future tasks remains separate. Ordinary chat, after leaving the task, does not inherit a hidden finite token override.

Offline regressions in `tests/task-budget-accounting.test.ts` exercise three overlapping primary/compaction admissions against real SQLite, monetary closure exhaustion, pre-dispatch refusal, late abort receipts, partial usage and retained policy across reopen. Existing task host/crash/backup tests remain applicable. No paid calls, external pilot, cross-host takeover, SDK patch, merge or publication is authorized by these tests.

Continuation also verifies the correspondence between task operation IDs in the
SDK token allocations and transport receipts, in both directions. An existing
initializer cannot recreate a missing monetary policy; retaining only the policy
cannot hide deleted receipts, and retaining receipts cannot hide deleted token
allocations. This detects missing records, not arbitrary tampering with matching
records. An inspection during the token-reserve/transport-insert transition can
report a transient missing receipt; retry after the invocation settles before
diagnosing permanent loss. It never grants new credit.

Consumed experimental PR187 accounts created before operation binding use random
transport IDs and cannot be continued or inspected through the combined task API.
Preserve their original database and inspect the separate historical ledgers;
there is no automatic migration based on row order or approximate totals. Ordinary
published run accounting and its legacy receipt rows retain their existing API.
After a process crash, transport rows may remain `pending` while the task is
blocked with uncertain effects. Their full exposure remains held; this increment
does not claim automatic conversion of every crashed row to `unknown`.
