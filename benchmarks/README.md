# Benchmark evidence

Benchmark implementations, deterministic fixtures, OCI image contracts, and their tests live in this repository because they measure Zhivex Harness behavior.

Complete generated reports remain local under [`results`](../results/). Only compact sanitized snapshots belong in [`baselines`](./baselines/). A baseline must omit raw samples, host details, worktree paths, and the invocation command, and must retain the exact report digest, dataset digest, model, image identity, matrix size, aggregate outcomes, confidence intervals, and evidence boundary.

These snapshots are local observations, not provider certification, public leaderboard results, or cross-platform performance guarantees.
