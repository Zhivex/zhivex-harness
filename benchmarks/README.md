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
