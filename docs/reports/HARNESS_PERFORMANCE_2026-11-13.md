# Harness performance changes — 2026-11-13

Baseline: `a87499d4cd78ae5edcf18c22f2e97f9828e8099f`. Candidate: local source changes,
not a published release. Compact results and SHA-256 evidence bindings are in
[the measurement summary](HARNESS_PERFORMANCE_2026-11-13.json).

## Implemented changes

- Activity persistence caches serialized runs for **one session**, bounded by the
  existing 2 MiB snapshot limit. Other SQLite connections invalidate it through
  `PRAGMA data_version`; publication follows successful commit. The full snapshot
  remains durable and compatible on disk. Retention uses scope/sequence and
  scope/time indexes plus a sequence cutoff instead of `NOT IN` over retained rows.
- Session listings fetch latest runs and counts in one page-scoped aggregate:
  **two SQL statements instead of 401** for a page of 200 populated sessions.
- Conversational scoped discovery reuses sources from its own refresh, eliminating
  the immediate second read/validation. Strict durable identity validation and
  refresh before the next model request remain unchanged; no TTL cache was added.
- Multi-file patches persist the complete mutation audit batch with one file
  sync/rename. The JSON format and per-file receipts remain unchanged; memory is
  updated only after successful persistence. Independent mutations still rewrite
  the accumulated audit; this is not an append-only journal migration.
- Tool descriptions prefer `search_many` for several already-known queries over
  the same scope. The underlying search algorithm was already batched; no new
  search speedup or model adoption rate is claimed.

The initial SQL JSON-update approach was discarded after local regressions.
Its three successful live attempts are retained separately in the JSON evidence,
not pooled with the selected implementation.

## Local comparison

macOS arm64, Apple M4. Bun 1.4.3 and Node 22.21.0 were measured separately.
Each runtime ran three baseline/candidate pairs, reversing order in the middle
pair. Tables show the median of the three within-process medians. Fixture setup
is excluded; filesystem caches were not flushed. No tests/builds ran concurrently
with this final comparison. These short samples do not estimate p95/p99 or
cross-platform performance.

Per process: 100 activity appends at each history size (about 22 KiB of text per
historical run), 30 lists of 200 sessions with one completed run each, 50 scoped
reads with 16 discovered instruction files, and five patches of 20 new files.
Activity stages grow the event journal as well as the snapshot, so they are a
combined history-growth workload, not an isolated serialization experiment.
Context timing uses a stub authorized file result to isolate instruction I/O;
patch timing includes workspace validation, file writes and auditing.

### Node 22.21.0

| Operation | Before ms | After ms | Time change |
| --- | ---: | ---: | ---: |
| Activity event, no history | 0.268 | 0.273 | +2.0% |
| Activity event, 40 historical runs | 3.809 | 1.468 | -61.5% |
| Activity event, 80 historical runs | 7.429 | 3.255 | -56.2% |
| List 200 sessions | 18.602 | 0.904 | -95.1% |
| Scoped guidance refresh + discovery | 1.147 | 0.641 | -44.1% |
| 20-file patch including durable audit | 206.223 | 128.118 | -37.9% |

### Bun 1.4.3

| Operation | Before ms | After ms | Time change |
| --- | ---: | ---: | ---: |
| Activity event, no history | 0.157 | 0.155 | -1.0% |
| Activity event, 40 historical runs | 1.536 | 1.231 | -19.9% |
| Activity event, 80 historical runs | 3.241 | 2.689 | -17.0% |
| List 200 sessions | 14.818 | 0.453 | -96.9% |
| Scoped guidance refresh + discovery | 0.758 | 0.462 | -39.0% |
| 20-file patch including durable audit | 15.808 | 12.071 | -23.6% |

The small empty-history difference is noise-sized; no improvement is claimed
there. Streaming still writes the full snapshot to SQLite on each event and
performs persistence-secret checks. The cache reduces JS work, not the storage
complexity. No safety check, durable commit or retention boundary was relaxed.

## Real OpenAI comparison

Model: `gpt-6-luna`, Responses mode, Bun 1.4.3. Three independent temporary-workspace
tasks per version, each reading two fixture files with `read_files` and producing
an 80–100-word requested explanation. Three steps and a 1,024-output-token harness
budget bound each task. Each activity store has 40 historical runs. No retries.

| Measurement | Baseline | Selected candidate |
| --- | ---: | ---: |
| Completed tasks | 3/3 | 3/3 |
| Median cumulative activity-handler time | 423.38 ms | 283.53 ms |
| Median total task time | 6,544.00 ms | 5,781.88 ms |
| Total tokens across three tasks | 5,670 | 5,608 |
| Cached input tokens reported | 0 | 0 |

Activity-handler time decreased by about **33%** in this small sample. Total task
time is descriptive only: runs were sequential, generated outputs and reasoning
lengths differ, and provider/network variation is uncontrolled. Three runs do not
establish an end-to-end speedup or token-cost reduction. Local Node measurements
are separate from these Bun live runs. Nine short live performance tasks were
executed including the discarded experiment (16,976 reported tokens total);
the additional approval smoke does not report token usage.

The optimized source also passed the existing real OpenAI approval smoke:
approval survived a process restart, with exactly one tool execution and one
journal entry. This is local functional evidence, not installed-artifact release
certification. The live candidate bundle predates a private audit-method naming
consolidation; that consolidation affects no exercised read-only/provider path.
The final local comparison uses the final candidate bundle. Bundle hashes are
recorded separately to preserve that boundary.

## Validation and reproduction

- Full `bun run test`: **2,383 passed, 1 skipped, 0 failed**, across 292 files.
- `bun run typecheck:tooling`, `bun run architecture:check`, `bun run contract:check`,
  `bun run docs:check`, `bun run migration:check`, and `bun run build` passed.
- Added regression coverage for interleaved activity writers and literal IDs,
  backwards-clock retention, paged session summaries, strict versus refreshed
  scoped guidance, and complete multi-file audit recovery after reopening.
- The initial sandbox suite was interrupted after a localhost-listen `EPERM`;
  the complete rerun with localhost access passed. No application regression was
  suppressed or excluded from the complete suite.

Run `bun run benchmark:harness --output /tmp/harness-overhead.json` locally.
For explicitly authorized real requests, run
`bun --env-file=.env run scripts/benchmark-harness-overhead.ts --live --output /tmp/harness-live.json`.
Pin the model using `ZHIVEX_HARNESS_LIVE_OPENAI_MODEL`. Capture each source variant
as a separate bundle before editing, then alternate executions with the same
runtime. Raw samples and bundles for this comparison remain in the ignored local
`results/performance-2026-11-13/` directory; the tracked summary binds them by hash.
Reports contain metrics and sanitized errors, never credentials or raw model text.
