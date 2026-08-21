# Local benchmark results

This directory is reserved for complete local benchmark reports and metadata sidecars. Its generated contents are ignored because reports can be large and may include host, worktree, command, and raw redacted sample metadata.

Do not publish files from this directory directly. Use `bun run benchmark:safe-fix:baseline -- ...` to verify the report digest and create a compact, sanitized evidence snapshot under [`benchmarks/baselines`](../benchmarks/baselines/).
