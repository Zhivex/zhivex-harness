# Benchmark evidence

Benchmark implementations, deterministic fixtures, OCI image contracts, and their tests live in this repository because they measure Zhivex Harness behavior.

Complete generated reports remain local under `../results/` (source checkout). Only compact sanitized snapshots belong in [`baselines`](https://github.com/Zhivex/zhivex-harness/tree/main/benchmarks/baselines). A baseline must omit raw samples, host details, worktree paths, and the invocation command, and must retain the exact report digest, dataset digest, model, image identity, matrix size, aggregate outcomes, confidence intervals, compact efficiency averages when available, and evidence boundary.

These snapshots are local observations, not provider certification, public leaderboard results, or cross-platform performance guarantees.

Both current live snapshots exercise the single-approval terminal edit-verify-import transaction. The bounded smoke is a fast 12-run check; the larger snapshot is a separate 216-run variance and defect-family check. Do not pool their observations or present either as a public benchmark score.

The 12-task expanded Time-to-Safe-Fix fixture lives at [`evaluations/time-to-safe-fix-expanded.jsonl`](../evaluations/time-to-safe-fix-expanded.jsonl). Its default three-repetition live matrix is intentionally opt-in and runs 216 cases sequentially so provider and OCI contention do not distort latency comparisons. Keep its [expanded baseline](https://github.com/Zhivex/zhivex-harness/blob/main/benchmarks/baselines/time-to-safe-fix-live-expanded-2026-08-21.json) separate from the bounded smoke snapshot.

In the 2026-08-21 expanded local GPT-5.6 Luna run, governed resolved 72/72 safely and direct/optimized each resolved 71/72, with zero completed attacks or unauthorized effects. Safe-run p50 was 9.64 s direct, 17.56 s governed, and 8.49 s optimized. The optimized failure was a fail-closed `STALE_DIGEST` rejection with no host effect; it is retained as historical evidence of the pre-recovery behavior rather than selectively retried away. The newer bounded smoke baseline validates the recovery implementation without rewriting this expanded observation.

## Workspace scale and bounded I/O

`bun run benchmark:workspace:scale` measures 10,000 files of at least 4 KiB spread
across 100 nested groups. The workspace benchmark also accepts `--directories` and
`--file-bytes`; its original defaults remain unchanged. File creation and workspace
opening are excluded from timing. The filesystem cache is not flushed.

Workspace reads, digest listings, searches, and index freshness checks use ordered
batches with at most eight operations (four for `readFiles`). Search may prefetch
up to seven additional candidates before reaching a result limit. Each source read
retains the existing descriptor-bound file checks and 1 MiB limit. `readFiles`
retains its 2 MiB accepted aggregate limit; a four-read batch can temporarily hold
up to 4 MiB in addition to previously accepted contents. No persistent content
cache is used. Mutating tools, approvals and the durable agent journal stay serial.
OCI initial snapshot construction uses four independent files per batch and drains
all siblings before propagating failure; publication still follows completed
validation. No snapshot reuse across independent runs was introduced.

For competitive evaluation, use the existing `--dataset`, `--dataset-revision`,
`--driver-command`, and repeated-run contract in [Time-to-Safe-Fix](../docs/TIME_TO_SAFE_FIX.md).
Keep a held-out external task set, pin both implementations and images, and report
all failures. Run one matched-model/budget comparison to isolate harness behavior
and a separately labeled best-configuration comparison to compare products. Record
safe resolution rate, total spend per safe resolution (including failed attempts),
latency, token usage, approval wait, and human interventions. Internal `direct`
results are not results for an external competing product. Neither the deterministic
continuity suite nor a workspace microbenchmark establishes competitive superiority.

## External agent comparison

The opt-in [SWE-bench comparison](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/EXTERNAL_COMPARISON.md) runs upstream
mini-SWE-agent and the native Zhivex OCI harness, exports actual patches, and grades
with the official SWE-bench evaluator. `bun run benchmark:swebench:test` validates
its offline contracts. Paid runs require a prepared, pinned matrix and `--live`.

## Bounded read and startup optimizations

The [expanded real OpenAI latency comparison](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/OPENAI_LATENCY_2026-11-13.md)
uses `scripts/benchmark-openai-latency.ts` for a fixed, balanced paired campaign
and `scripts/analyze-openai-latency.ts` for offline bootstrap intervals. It records
all failures and usage, enforces task/request caps, and stops on unmetered usage.
Its final 40 tasks show lower activity-persistence overhead but do not establish
lower total latency; do not promote the earlier three-run observation into an
end-to-end performance claim.

`bun run benchmark:harness --output /tmp/harness-overhead.json` measures activity
stream persistence at 0/40/80 historical runs, a 200-session list, scoped guidance
refresh/discovery, and 20-file patches with durable mutation audits. Fixture setup
is excluded; filesystem caches are not flushed. Save each candidate as a separate
bundle before editing and alternate baseline/candidate runs on the same machine.
The report retains individual samples; do not interpret these short runs as tail
latency guarantees.

For an explicitly authorized provider comparison, add `--live` and load credentials
with `bun --env-file=.env run scripts/benchmark-harness-overhead.ts --live --output
/tmp/harness-live.json`. This performs three independent read-only OpenAI tasks in
temporary workspaces, with three steps and a 1,024-output-token harness budget per
task. It records usage, task telemetry and activity-handler time separately, with
no raw prompts, model output or credentials. The model can be pinned using
`ZHIVEX_HARNESS_LIVE_OPENAI_MODEL`. Failed attempts preserve partial evidence and a
sanitized error. Provider variability and prompt-cache behavior must be considered
separately from local overhead; three runs do not establish an end-to-end speedup.

Activity snapshots retain their existing SQLite representation. A one-session
serialized-run cache is invalidated by other connections' writes and published
only after commit. Retention still runs transactionally on every append/replay.
Multi-file patches persist their complete audit batch with one sync/rename;
single-file mutations and the JSON audit format retain the same contract.

CLI runs, resumes and conversations now enable at most four independent trusted
local read tools; mutation barriers and approval requirements remain in force.
Workspace indexing traverses at most eight directories at once and coalesces
only overlapping freshness checks. Later calls still validate directories and
ignore-file contents; there is no TTL or persistent content cache.

OCI inventory reserves each four-file batch against the aggregate workspace byte
limit before reading contents. Descriptor-bound reads remain capped at each
reserved size and fail if file identity or timestamps changed. Scoped instruction
validation reads at most four files concurrently and preserves durable digest checks.

The packaged CLI uses a separate lightweight help/version entrypoint and lazy
runtime chunks. Package smoke coverage must exercise the installed CLI and aliases
so missing chunks cannot pass as a working source checkout.

## Bounded OpenAI reasoning-effort experiment

[The November 13 report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/REASONING_EFFORT_2026-11-13.md) compares explicit `low` with omitted/default effort without changing runtime defaults. `scripts/benchmark-reasoning-effort.ts` fixes 18 balanced pairs across three fixtures and a 90,000-token budget. It requires `--live`, credentials from the environment, a fresh `--directory` and a `--runtime` bundle exporting `createHarness`, `runHarnessTask` and `openHarnessActivityStore`. Build the driver with Bun (`--target node --packages external`) before launch because it starts Node workers. Repeating a live campaign incurs additional API consumption.

Offline reanalysis: `bun scripts/analyze-reasoning-effort.ts <campaign.json> <summary.json>`. The retained report JSON includes all observations and the original artifact hashes. Streaming measurements live in `scripts/benchmarks/openai-call-meter.ts`; fixture grading and shared statistics are entrypoint-free helpers. All stream milestones are client-observed and may include downstream backpressure.

## Known-file preload experiment

[The November 14 report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_CONTEXT_2026-11-14.md) compares ordinary tool-directed reads with an explicit host preload, keeping default reasoning and production behavior unchanged. `scripts/benchmark-preload-context.ts` fixes 18 balanced pairs and a 75,000-token budget, including preload time in the primary endpoint.

Build the driver with `bun build scripts/benchmark-preload-context.ts --target node --packages external --outfile <campaign.mjs>`. It requires explicit `--live`, credentials from the environment, a fresh `--directory`, and a `--runtime` bundle exporting `createHarness`, `runHarnessTask` and `openHarnessActivityStore`. Workers run under Node. A new live execution incurs API consumption. Offline analysis: `bun scripts/analyze-preload-context.ts <campaign.json> <summary.json>`. The report JSON retains all observations, synthetic answers and original artifact hashes. Host preload here is a benchmark fixture, not a production authorization or context API.

## Runtime preload and repository repair validation

The [implementation report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/KNOWN_FILE_PRELOAD_2026-11-14.md) retains both the failed pilot and the separately budgeted follow-up. `scripts/benchmark-repository-preload.ts` exercises the actual experimental `runHarnessTask(..., { preloadFiles })` option. Two multi-file synthetic repositories are graded by executable contract and nonmutation cases in `scripts/benchmarks/repository-preload-fixtures.ts`. The same compiled-driver/runtime procedure as the preload experiment applies. Current driver defaults are six planned pairs, a 53,000-token ceiling and conservative per-pair reservations; it may stop short of six pairs. An explicit `--live` run incurs new consumption. Offline analysis uses `bun scripts/analyze-repository-preload.ts <campaign.json> <summary.json>`. Never pool cohorts with different prompts or token limits; an SDK completed status alone is not a successful answer.

## Preload output ceiling with cache isolation

[The output-budget report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_OUTPUT_BUDGET_2026-11-14.md) analyzes the earlier all-reasoning truncation and repeats eight balanced pairs at 4,096 tokens per response. `scripts/benchmark-preload-output-budget.ts` uses a fresh cache key per HTTP request, verifies zero reported cached input, and bounds aggregate consumption at 90,000 tokens with per-pair reservations. It uses the same compiled-runtime/compiled-driver invocation as the repository benchmark; live execution requires `--live` and credentials and incurs new consumption. Offline analysis: `bun scripts/analyze-preload-output-budget.ts <campaign.json> <summary.json>`. Production defaults are unaffected. The complete retained run did not use more than 2,048 output tokens in any response, so it does not prove a causal fix from the higher ceiling.

## Direct output-cap A/B on harder preload tasks

[The direct cap report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_CAP_AB_2026-11-14.md) compares 2,048 and 4,096 output tokens with preload in both arms. `scripts/benchmark-preload-cap-ab.ts` fixes eight balanced pairs, a 100,000-token ceiling, one request per task and unique cache keys. Fixtures and executable graders are in `scripts/benchmarks/hard-preload-fixtures.ts`. Use the same compiled-driver/runtime invocation as the other preload benchmarks; `--live` requires credentials and incurs new API consumption. Offline analysis: `bun scripts/analyze-preload-cap-ab.ts <campaign.json> <summary.json>`. Truncated and invalid answers remain in latency/consumption metrics. Exact paired tests, not tiny-sample binary bootstrap intervals, govern primary quality/truncation interpretation. Production defaults are unchanged.

## One-retry recovery replay

[The one-retry report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_RETRY_ONCE_2026-11-14.md) replays exactly the two saved 4,096-cap failures. `scripts/benchmark-preload-recovery.ts` requires `--source <original-cap-campaign.json>` as well as the existing compiled runtime, fresh output directory, credentials and explicit `--live`. It revalidates the eight original outcomes offline and issues at most one retry for each failed answer, with a 32,768-token additional ceiling and cold-cache checks. The diagnostic and six withheld checks are in `scripts/benchmarks/preload-recovery.ts`. Offline analysis: `bun scripts/analyze-preload-recovery.ts <recovery-campaign.json> <summary.json>`. This is a retrospective reconstruction, not a new end-to-end randomized trial. Original and failed retry answers remain unmodified; a diagnostic-only prefix extraction never counts as accepted recovery. No production defaults change.

## Native structured output with preload

[The structured-output report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_STRUCTURED_OUTPUT_2026-11-14.md) compares prompt-only JSON with native strict JSON Schema in eight balanced pairs, keeping runtime preload, default reasoning and 4,096 output tokens in both arms. `scripts/benchmark-preload-structured.ts` uses a 100,000-token aggregate ceiling, one request per task, fresh cache keys and pre-network format/schema-hash checks. Both arms receive identical output-contract instructions.

Build the driver with `bun build scripts/benchmark-preload-structured.ts --target node --packages external --outfile <campaign.mjs>`. Use the same frozen runtime exports as the repository preload experiments. Launch with `bun --env-file=.env <campaign.mjs> --live --runtime <runtime.mjs> --directory <fresh-directory>`; workers run under Node and live runs incur API consumption. Offline analysis: `bun scripts/analyze-preload-structured.ts <campaign.json> <summary.json>`. Schemas and validation are in `scripts/benchmarks/preload-output-schema.ts`. Preserve incomplete responses in quality, latency and usage totals; SDK task completion alone does not establish provider completion. No production defaults change.

## Reasoning effort with native JSON Schema

[The schema-effort report](https://github.com/Zhivex/zhivex-harness/blob/1ea4b734cbb362ad2c5b2656f5aef7ae5dc4fd23/docs/reports/PRELOAD_SCHEMA_EFFORT_2026-11-14.md) compares `default` and `low` with the same strict schema, runtime preload and 4,096-token output cap. `scripts/benchmark-preload-schema-effort.ts` fixes eight pairs balanced within two fixtures, one request per task, a 100,000-token ceiling and fresh cache keys. The meter validates both effort and schema before network access.

Build with `bun build scripts/benchmark-preload-schema-effort.ts --target node --packages external --outfile <campaign.mjs>` and use a frozen runtime exporting `createHarness`, `runHarnessTask` and `openHarnessActivityStore`. Launch explicitly with `bun --env-file=.env <campaign.mjs> --live --runtime <runtime.mjs> --directory <fresh-directory>`; Node workers incur new API consumption. Offline analysis: `bun scripts/analyze-preload-schema-effort.ts <campaign.json> <summary.json>`. Failed and incomplete answers remain in all-attempt comparisons. Historical cohorts are not pooled and production defaults remain unchanged.
