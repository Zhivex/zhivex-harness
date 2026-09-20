# Qwen Chat terminal tool calls

Local SDK proposal on `feat/qwen-terminal-tool-calls` in `/tmp/harness-ga-qwen-review`.
The base commit and validated file hashes are recorded in evidence.json.

Qwen 0.14.3 drops streamed calls when named tool selection returns `stop`.
The patch materializes valid buffered calls on `stop` or `tool_calls` after
normal stream completion, validates the whole batch before emission, and rejects
truncated or invalid batches with typed errors and terminal usage when available.
It requires Core 1.22.0. No public API exports change.

Validation: 209 Qwen tests; 2,424 SDK tests; types/examples, docs and build pass.
The compiled adapter passes the Harness offline acceptance fixture.
The package has not been published; the Harness still installs Qwen 0.14.3.
The patch includes a Qwen patch changeset. No push or PR was performed.

Local commit: `35e2bb49340acb68af125fc03df4389cab785c28`. Installed-consumer smoke passes (51 entrypoints,
Bun 1.4.2). A synthetic live probe with the compiled adapter now preserves
repair_plan under both named selection with provider finish stop and required
selection with provider finish tool_calls. No tool execution or repository
repair was performed by that probe; this is not published-package evidence.

The installed local tarball also passed one complete known Django development
repair through Harness verification/import and independent SWE-bench grading:
Harness 1/1, unchanged control 1/1. See the Harness report evidence
`docs/reports/evidence/ga-qwen-patched-package-2026-09-19.json`.
This is not fresh holdout, statistical reliability, or registry certification.

Final local review commit: `c850ae0bcde057bccb0e380197de065708408910` adds rejection of a late explicit provider
error before any buffered call is emitted. The whole SDK suite now passes 2,425
tests; types, docs, build and compiled offline acceptance pass. Installed
consumer/live evidence above remains bound to 35e2bb4 and is not relabeled as
validation of this later commit. `PR_BODY.md` contains a review-ready description.

Installed-consumer validation was subsequently repeated successfully on final
commit c850ae0 (51 entrypoints, Bun 1.4.2). Only the live evidence remains
bound to 35e2bb4. A specific request to push this SDK branch and open a PR
is pending; no remote mutation has been performed.
