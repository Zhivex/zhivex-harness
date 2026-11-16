# Compaction read continuity and failed-read traces — 2026-11-15

**Final runtime: 4/4 accepted real-model repairs under forced compaction; previous
runtime: 0/4.** Early and late context, executable quality checks and security
checks passed in every final optimized task. This is a continuity correction,
**not a reduction in raw provider tokens** on non-repetitive code. A failed task
consuming fewer tokens is not a cheaper completed task.

## Production changes

- After compaction, request preparation restores omitted `read_file`, `read_files`
  and `read_tool_result` exchanges from the same scoped durable run. Each restored
  result must match its original call ID and tool name and remain in the current
  catalog. Missing durable evidence/call provenance fails closed. Existing tail
  exchanges are not duplicated. Restored data stays in tool-result roles, before
  the newer retained context, with an explicit historical/untrusted notice. It
  does not grant approval, become a system instruction, or count as a fresh read
  for editing.
- Replay is **wire-only**. The original messages are restored in `finally` after
  generation/stream consumption, before the SDK snapshots the request. The SDK
  can compact the stored conversation without repeatedly persisting replayed
  copies. Existing transport admission sees the full expanded request and can
  reject it before dispatch; token/step limits are unchanged.
- Replayed file content uses the existing reversible line encoding when suitable,
  even without a paging tool, and otherwise stays raw. A per-run/scope cache is
  bounded to 8 MiB of serialized source plus encoded bytes. Reuse requires exact
  serialized equality; a matching call ID or file digest alone is insufficient.
- `onDiagnostics.readAttempts` reconstructs attempted paths from durable original
  call arguments, including failed/denied reads. It records call ID, step, name,
  outcome and typed error code, without result contents or arbitrary error text.
  Paths are redacted/bounded; omitted, truncated, missing-argument and orphan
  records are explicit. Up to 256 recent attempts are returned. The benchmark
  verifies this production trace against an independent reconstruction.
- Context/projection fingerprint versions changed to prevent silent incompatible
  resume. Existing mutation, approval, scope and fresh-evidence checks remain in
  force.

The compaction threshold is a **soft durable-conversation target**, not the
provider's hard context limit. The working read evidence can exceed that target
on the wire. Preserving arbitrary non-repetitive content requires tokens; when
it does not fit the actual authorized budget, the run stops rather than silently
losing facts. Other conversation summaries remain lossy. This change does not
claim universal semantic preservation of every possible history.

## Final real-model comparison

The unchanged fixtures repair real repository `path-policy.ts` and
`text-integrity.ts` modules with controlled defects. Six complete bounded source
files contain about 67,000 characters of non-repetitive repository code. Checks
cover early/late acceptance identifiers, `bun-only`, exact source-read order,
passing executable Bun regressions, no forbidden reads/tool calls or input
mutation, complete attempted-read trace and matching SDK/provider usage.

Two modules × two models form four A/B pairs, alternating order by module. Before
is the immutable optimized runtime from the previous code-context campaign;
after is the final wire-only replay bundle. Both use full-history OpenAI
Responses, low reasoning, 4,096 maximum output tokens/request, eight steps,
300,000 input / 16,000 output / 316,000 total task tokens, and a **12,000 estimated
compaction threshold**. No production budget was increased. There are no retries
or post-hoc repairs in this final cohort.

| Model | Accepted before → after | Total tokens before → after (2 attempts/arm) | Mean verified seconds before → after | Estimated USD per accepted task before → after |
| --- | --- | --- | --- | --- |
| gpt-6-luna | 0/2 → 2/2 | 76,074 → 206,540 | 12.856 → 13.428 | undefined → $0.0105286 |
| gpt-6.1-sol | 0/2 → 2/2 | 101,131 → 180,717 | 13.440 → 12.833 | undefined → $0.1829130 |

Optimized tokens per accepted task are **103,270** for Luna and **90,358.5** for
Sol. Before has no accepted tasks, so neither a finite baseline cost per success
nor a cost-saving percentage is meaningful. Before's timings are failed-attempt
timings, not time to a completed repair. With two pairs per model, latency is
reported descriptively; no general speedup is established.

The final optimized runs performed **10 actual SDK compactions** and sent replayed
read history in 18 requests. All four retained both context identifiers and the
scoped policy; all four patches passed the hidden functional/security tests on
the first submitted proposal. A harmless missing-target reread remains charged
and traced. No failed read was treated as successful evidence. Complete attempted
read traces exist for all eight runs; the four optimized production diagnostics
match the independent durable reconstruction exactly. Cache hits reported by the
provider were zero; all usage receipts were known.

The final cohort used **564,462 tokens**, estimated **$0.6018070** across all eight
attempts. USD per accepted task = cost of **all attempts in that arm** / accepted
tasks. Output already includes reasoning. Rates are [OpenAI Standard short-context
pricing](https://developers.openai.com/api/docs/pricing), verified 2026-11-15:
Luna input/output/cached $0.10/$0.50/$0.01 and Sol $2.00/$10.00/$0.10 per million.
These are public-rate estimates, not invoices.

## Preserved intermediate failures and accounting

The first replay implementation restored context successfully but the SDK then
persisted the expanded requests. The full suite exposed this in its 200-read
history test: it exceeded 180 seconds, and remaining work caused cascading test
timeouts. The suite was stopped. A cache/encoding-only intermediate version did
not resolve persistence inflation; neither is the final implementation.

The initial real-model campaign remains immutable: 16 attempts, 1,307,438 tokens,
$1.4467663 estimated. It included pressure and relaxed thresholds. Context was
retained in all eight optimized attempts, but Luna proposed one incorrect patch;
the test gate rejected it. A separate exploratory one-pass verification repair
was applied to both eligible code-failing proposals (one per arm): 34,238 additional
tokens, $0.0036070, one accepted and one still rejected. No bad proposal was
accepted or applied to the repository. These results are **not pooled into the
final-runtime success denominator**.

After correcting wire-only lifetime, the final frozen runtime was reevaluated in
all four pressure pairs, not just the previously failing task. Total work in this
fix cycle: **26 paid attempts, 1,906,138 tokens, $2.0521803 estimated**, with no
unknown usage receipts. The original two-million-token intermediate ceiling and
the separately announced final 1.2-million-token ceiling are preserved in the
campaign plans. Offline tests made no model calls.

## Durability, safety and limits

The final isolated history regression completed **200 reads and 99 compactions in
34.22 seconds**, then reopened the store and restored its portable backup.
Hydrated state was 10,972,429 bytes; the persisted checkpoint was only **45,249
bytes**. Assertions verify that the replay notice and expanded history never
become the durable conversation. This fixes the observed timeout without raising
the test's 180-second deadline.

Tests verify exact round-trip content, cache invalidation, missing-provenance
refusal, idempotent replay, six reads surviving repeated SDK compaction without
recovery calls, blocked `.env` reads with recorded arguments, no canary disclosure,
and both model-budget and checkpoint-budget rejection of expanded requests before
generate/stream dispatch. Existing approval, scope, filesystem and mutation
regressions are included in repository validation.

Generated proposals are evaluated only in the existing isolated Bun grader:
read-only model tools, bounded expression replacements, no model shell/network,
and a child process without provider credentials. Its macOS sandbox blocks network,
user-home reads and writes outside its temporary grading directory. This is a
bounded regression campaign, not a general certification of arbitrary generated
programs, unlimited histories or all models.

## Evidence and reproduction

- [Final raw campaign](evidence/code-context-replay-final-2026-11-15/campaign.json) and [cost/latency/quality summary](evidence/code-context-replay-final-2026-11-15/summary.json)
- [Final runtime manifest](evidence/code-context-replay-final-2026-11-15/runtime-manifest.json), adjacent before/after bundles and [source bindings](evidence/code-context-replay-final-2026-11-15/source-bindings.json)
- [Durable-history test](evidence/code-context-replay-final-2026-11-15/durable-history.txt)
- [Complete fix-cycle ledger](evidence/code-context-replay-final-2026-11-15/ledger.json)
- [Intermediate raw campaign](evidence/code-context-replay-2026-11-15/campaign.json) and [bounded verification-repair attempts](evidence/code-context-replay-repairs-2026-11-15/repairs.json)

```sh
bun test ./tests/working-read-replay.test.ts ./tests/durable-history.test.ts
bun scripts/benchmarks/code-context/freeze-replay.ts /tmp/previous-code-runtime /tmp/replay-runtime-new
bun --env-file=.env scripts/benchmark-code-context-replay-final.ts --live --runtimes /tmp/replay-runtime-new --directory /tmp/replay-evidence-new
bun scripts/analyze-code-context-replay.ts /tmp/replay-evidence-new/campaign.json /tmp/replay-evidence-new/summary.json
```

The freezer requires the previous campaign's `after.mjs` and `manifest.json`,
validating their hash before using that bundle as the control. Current source
builds the new arm. Use new output directories; live runs incur charges. The
archived bundles bind this report to the tested runtimes and locked dependencies.

## Final repository validation

Bun 1.4.3: `bun run test` completed with **2,733 passed, 1 skipped, 0 failed**
across 366 files (247.30 seconds), including the original unchanged 200-read
history deadline. `typecheck`, `typecheck:tooling`, `architecture:check`,
`docs:check` and `git diff --check` passed. The intermediate timeout/aborted suite
is retained as a failed development check; it is not presented as a passing run.
