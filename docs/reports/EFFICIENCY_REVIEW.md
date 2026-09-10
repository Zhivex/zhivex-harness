# Efficiency implementation evidence — 2026-09-08

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

## SDK patch integration

The measured checkout pinned published Core 1.13.0, Agents 1.3.1 and OpenAI 0.11.2,
including the Core override and lockfile. The isolated three-response diagnostic
now reports 300 input tokens for 300 measured tokens. Consumer regressions exercise
persisted and unpersisted streams, compactor usage, per-step budgets, real approval
resumes and synthetic assistant serialization through mocked Responses HTTP.

The local usage-accounting correction and compacted-history transport projection
have been removed. The SDK preserves complete interaction groups and assistant
roles; the harness no longer drops orphan observations or changes summary roles.
The new runtime identity requires older paused runs to use their matching artifact.
Those checks are installed-package evidence. The subsequent live
[repeated-cohort comparison](./EXTERNAL_COMPARISON.md#sdk-upgrade-reevaluation--2026-09-08)
resolved 2/5 cases for Zhivex and 3/5 for mini-SWE-agent, with 19.4% fewer Zhivex
input tokens than its previous run. It does not establish general superiority.
The sections below describe the earlier development evidence and task creation.

Upgrade validation passed: 442 tests, documentation and contract checks, typecheck,
migrations, deterministic evaluations and local benchmark checks. MCP loopback
checks required execution outside the sandbox; both MCP smokes, real OCI execution
and installed-package smoke passed with that permission. The isolated SDK diagnostic
also passed with the published dependency versions and no provider calls.

## Follow-up: command selection and user corrections

Configured OCI executable allowlists now appear as enums in all four command
tool schemas, including batch and verified-edit transactions. Descriptions expose
the configured choices and the Python module invocation for pytest when Python is
allowed. This does not broaden process permissions or guarantee module installation;
the execution session still enforces policy and exact approval. Calls to the public
factory without a configuration retain the legacy schema and direct the model to
`environment_status`.

Compaction strategy `bounded-evidence-v2` retains three bounded user corrections
separately from assistant excerpts. A regression runs five compactions with twenty
assistant messages between each, preserving the correction inside the same 4,000
character summary ceiling. This is deterministic continuity evidence, not a new
external benchmark result. Previous paused runs require their matching artifact.

The SDK team backlog in Notion's Zhivex area contains these verified-created tasks:

- [Persisted stream usage duplication](https://app.notion.com/p/3d5777b104f6810a8e46df7186bf5e21):
  reproducible offline using `bun --no-env-file run scripts/diagnose-sdk-compaction.ts`.
  Core 1.11.0 reports 500 input tokens for three measured responses of 100 when a
  store and compaction are enabled. Without a store the isolated control reports 300.
- [Synthetic assistant serialization](https://app.notion.com/p/3d5777b104f6818db026dea3738f9b5b):
  OpenAI 0.10.0 transport contract issue; the earlier harness projected summaries
  into user context.
- [Approval/tool group boundaries](https://app.notion.com/p/3d5777b104f6814b80f2d46269c9453c):
  code inspection and transport regression; the SDK task explicitly requires an
  integrated approval/compaction reproduction before implementing an upstream fix.

At creation all three were tagged SDK-Typescript, priority Alta, status Sin empezar.
Their SDK fixes are now integrated as described above; this historical record does
not assert their current Notion workflow status.

Follow-up validation: 429 tests passed, plus documentation, stable contracts,
typecheck, migrations, deterministic evaluations and local benchmark checks.
The sandbox blocked the loopback MCP listener; MCP interoperability (controlled
and official SDK), real Docker OCI and installed-package smoke subsequently passed
with the required local execution permission. The isolated SDK diagnostic was also
typechecked and executed without provider calls. No new external score is claimed.

Implemented on top of `0a7b69dddaa70a54b6b5b4097691c8112d4d76eb` as an
uncommitted development change. Compact source-report digests and aggregate
measurements are recorded in [the baseline](../../benchmarks/baselines/efficiency-2026-09-08.json).
Full reports remain local under `results/efficiency/2026-09-08/`.

| Measurement (p50) | Before | After |
| --- | ---: | ---: |
| Three searches, 10,000 small files | 1,136.79 ms | 492.41 ms |
| `searchMany`, 10,000 small files | 941.46 ms | 232.24 ms |
| Digest inventory, 10,000 small files | 970.63 ms | 245.74 ms |
| Reused topology inventory, 100 nested groups / 1,000 files | 27.61 ms | 10.32 ms |
| OCI session acquisition, 1,000 source files | 417.04 ms | 193.16 ms |

Three repetitions per measurement, Bun 1.4.0 on local macOS ARM64, filesystem
cache not flushed. These are sequential development observations, not randomized
paired trials. The nested and OCI before/after measurements isolate later stages:
both already include concurrent content reads; OCI after additionally includes
batched index freshness and snapshot construction. No model latency or human
approval time is represented by these workspace numbers. No p99 claim is warranted.

Validation: full `bun run check` passed, including 414 tests, historical migrations,
deterministic evaluations, workspace/safe-fix benchmarks, MCP interoperability,
real Docker 29.7.2 OCI smoke, and the installed package smoke. Tests exercise batch
failure draining, early termination, deduplication, aggregate limits, symlinks,
Unicode pagination, changed file contents, repeated compaction and redaction.
The Stable declaration snapshot update reflects only TypeScript's reordered
`fulfilled`/`rejected` enum members, checked against declarations emitted from the
base checkout. It does not add or remove a public API member.

Reproduce workspace scale with `bun run benchmark:workspace:scale`, continuity with
`bun run evaluate:continuity`, and OCI with `bun run benchmark:oci`. See the
[benchmark guide](../../benchmarks/README.md) for limits and competitive methodology.

Remaining research: persistent content indexing, semantic plans/constraint retention,
automatic model selection and cross-tool concurrency. Those mechanisms were not
introduced by this patch. External held-out agent evaluations still require a
selected competing implementation, dataset and matched runtime/model budgets; the
existing external-driver interface is available but no competitor was executed.

## External-pilot follow-up

The follow-up adds exact approved replacements to avoid generating full files,
reduces default read/search volume, preserves the objective through SDK-formatted
compaction, and fixes model-transport context at compaction boundaries. OCI's
inventory uses the snapshot byte budget independently of the model's file-read
limit, allowing large unchanged fixture files. The authority inventory and enforced
OCI tool list both include the new replacement tool.

One previously failing development task produced an officially accepted repair
with two compacted continuations after these fixes. That run subsequently exhausted
its input budget after already importing the patch; the frozen comparison ends on
the approved import receipt. This development result is not holdout evidence.
See [the external comparison](EXTERNAL_COMPARISON.md) for the independent selection.

## Qwen repair follow-up

The subsequent implementation adds exact-file batched searches, character-bounded
read output, earlier benchmark compaction, remaining-budget reminders and required
verification before native benchmark import. Command telemetry retains typed exit
codes and timeouts without raw logs. Qwen adapter 0.11.4 incorporates the upstream
streamed-usage fix. Validation passed 446 tests and the MCP, OCI and installed
package checks.

The repeated five-case comparison using `qwen3.8-flash` with thinking disabled
resolved 0/5 for Zhivex and 2/5 for mini-SWE-agent. Native input usage was 424,720
tokens: three attempts reached the budget, one failed argument validation and one
failed final verification (exit 4), preventing import. This is no demonstrated
competitive improvement. Model and harness changes are confounded, and the cases
are known development data. See the [full result and limitations](EXTERNAL_COMPARISON.md#qwen-flash-repair-reevaluation--2026-09-08).

## Navigation retention follow-up — 2026-09-09

The harness compactor previously ignored nested file references in batched search
and read outputs. Strategy `bounded-evidence-v3` now retains up to eight validated,
deduplicated path/digest/line references within the existing total summary budget.
New observations with a changed digest replace older locations for that file.
Current source must still be read before editing; historical locations do not
authorize edits or stand in for source content.

The [deterministic control](../../benchmarks/baselines/context-navigation-2026-09-09.json)
retains two locations through six successive compactions, compared with zero in
the archived v2 implementation. On this small fixture the summary grows from 225
to 553 characters, still below the 4,000-character cap. This is improved information
retention, not measured token savings. The intended benefit is avoiding repository
rediscovery after compaction; a fixed-model live comparison is still needed to
measure that benefit. Regression tests use actual workspace batched outputs and
cover redaction, stale references, clipped lines, hostile recalled metadata and
small summary budgets. The local suite passes 456 tests.
