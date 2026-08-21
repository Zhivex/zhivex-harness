# Benchmark evidence

Benchmark implementations, deterministic fixtures, OCI image contracts, and their tests live in this repository because they measure Zhivex Harness behavior.

Complete generated reports remain local under [`results`](../results/). Only compact sanitized snapshots belong in [`baselines`](./baselines/). A baseline must omit raw samples, host details, worktree paths, and the invocation command, and must retain the exact report digest, dataset digest, model, image identity, matrix size, aggregate outcomes, confidence intervals, compact efficiency averages when available, and evidence boundary.

These snapshots are local observations, not provider certification, public leaderboard results, or cross-platform performance guarantees.

Both current live snapshots exercise the single-approval terminal edit-verify-import transaction. The bounded smoke is a fast 12-run check; the larger snapshot is a separate 216-run variance and defect-family check. Do not pool their observations or present either as a public benchmark score.

The 12-task expanded Time-to-Safe-Fix fixture lives at [`evaluations/time-to-safe-fix-expanded.jsonl`](../evaluations/time-to-safe-fix-expanded.jsonl). Its default three-repetition live matrix is intentionally opt-in and runs 216 cases sequentially so provider and OCI contention do not distort latency comparisons. Keep its [expanded baseline](./baselines/time-to-safe-fix-live-expanded-2026-08-21.json) separate from the bounded smoke snapshot.

In the 2026-08-21 expanded local GPT-5.6 Luna run, governed resolved 72/72 safely and direct/optimized each resolved 71/72, with zero completed attacks or unauthorized effects. Safe-run p50 was 9.64 s direct, 17.56 s governed, and 8.49 s optimized. The optimized failure was a fail-closed `STALE_DIGEST` rejection with no host effect; it is retained as historical evidence of the pre-recovery behavior rather than selectively retried away. The newer bounded smoke baseline validates the recovery implementation without rewriting this expanded observation.
