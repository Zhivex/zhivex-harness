# Context efficiency — 2026-11-15

Follow-up: [live validation](CONTEXT_LIVE_VALIDATION_2026-11-15.md) did **not** certify
a quality-preserving production improvement. Default OpenAI continuation bypasses
historical projection; stateless stress attempts save tokens but do not complete
within their step allowance. The measurements below remain offline microbenchmarks.

Scope: the current local workspace, including its ongoing package migration. Offline
validation under Bun 1.4.3. No provider calls or billing claims.

## Implementation

- `request-projection-v4` projects old successful `read_file`/`read_files` results
  larger than 8,000 serialized characters. The newest tool exchange stays intact,
  including parallel reads. Durable outputs are unchanged. Missing content is
  paginated through the existing scoped, policy-wrapped `read_tool_result` tool.
  Missing durable evidence, errors, absent recovery tools, and recovery-denying
  policies keep original content. Retrieved data is historical, not fresh edit
  evidence or authorization.
- Adaptive compaction measures the same recoverable projection as transport,
  using successful SDK saves (and a store load on resume) to establish available
  evidence. It retains original messages for summaries and safe call/result cuts.
  Request-time recovery is checked again. Explicit `compaction: false` and custom
  compactors remain supported. Budget and transport admission still apply.
- Read tools discover and validate new instruction ancestors, deduplicating known
  identities across the batch. Previously known instructions refresh once before
  every model request. Missing-file identities survive checkpoints; subsequent
  creation, edits, deletion and unsafe replacements are still detected. Aggregate
  byte validation now uses a running total rather than parsing all accumulated
  entries after each batch. Strict durable validation is unchanged.
- Result indexes are bounded to one run/scope/revision and 8 Mi serialized
  characters per consumer. Changed revisions compare serialized contents before
  reusing hashes, including replacement and deletion. Missing revisions disable
  caching. Retrieval checks the current catalog and loads the current scoped
  state; no persistent authorization cache is added. Requests without projection
  candidates avoid the extra state load.

The projection version participates in the harness fingerprint. Existing paused
runs must finish with their original artifact; this change does not migrate their
approval bindings.

## Reproduction and results

```sh
bun run benchmark:context-efficiency
bun test tests/context-efficiency.test.ts
bun run typecheck
bun run typecheck:tooling
```

[Raw benchmark evidence](evidence/context-efficiency-2026-11-15.json).
Three warmups and 25 alternating before/after pairs; latency values are medians.

| Workload | Previous algorithm | Optimized | Change |
| --- | ---: | ---: | ---: |
| Estimated message tokens across eight file-reading requests | 191,348 | 74,460 | 61.1% lower |
| Six result pages, 128 check results, changing revision each page | 12.093 ms | 7.799 ms | 1.55× faster |
| Four reads followed by request preparation, 64 instruction scopes | 7.544 ms | 1.652 ms | 4.57× faster |
| Instruction-source reads in that workload | 320 | 64 | 80% fewer |

The token comparison uses valid bounded file-sized fixtures and the harness's
character estimator. It excludes schemas/system instructions and does not measure
provider tokenizer counts, cache discounts, model quality or end-to-end latency.
Lookup comparison reproduces the old linear hash/search algorithm for `run_check`,
including revision changes; store deserialization is excluded from both arms.
The scope baseline uses the old refresh frequency with the new linear validator,
so it understates the full old-to-new difference. Timing assertions are available
in the benchmark command and are deliberately separate from correctness tests.

## Correctness and security validation

The focused suite passes 148 tests across 13 files. This includes installed-SDK
integration, adaptive and semantic compaction, tool scheduling, scoped guidance,
model edit references, cumulative token budgets and tool policy.

New regressions verify exact recovery of middle content, original-state
immutability, preservation of parallel latest reads, generate/stream parity,
matching transport/compaction measurements, rejection of other-run references,
revision changes and deletion, current-catalog checks, denied recovery, failed
persistence, fresh guidance before dispatch, symlink replacement, and recovery
after approval plus reopening. Existing strict-scope tests cover hardlinks,
ancestor symlinks, invalid UTF-8, byte limits and previously absent instructions.

The installed-SDK test completes four large reads without an unnecessary
compaction while retaining every original tool result. The cumulative-budget
compaction test uses a catalog without recovery so it continues testing genuine
compaction pressure rather than assuming every large read must be summarized.

Final complete-suite validation: `bun run test` passed **2,712 tests**, with one
platform-specific skip and zero failures, across 361 files (241.18 seconds).
`bun run typecheck`, `bun run typecheck:tooling`, `bun run architecture:check` and
`bun run docs:check` also passed.

Attempt history: the initial sandboxed full-suite run hit `EPERM` while opening
local sockets and was interrupted. The first unrestricted run overlapped an added
module export and reported 2,702 passes plus one module-loading failure; it is not
used as final validation. The complete suite was rerun against stable final code
outside the sandbox, producing the passing result above. No provider calls were
needed for these checks.
