# Context efficiency implementation — 2026-09-22

Implemented against the current local checkout, including its existing RC.4 work.
This is local validation, not a published release or a live model benchmark.

## Changes

- `adaptive-tokens-v1` selects recent history by token estimate as well as message
  count. It preserves whole tool/approval groups and aims for 65% of the trigger,
  allowing space for policy, tools and a bounded summary. Repair runs lower the
  trigger with remaining input allowance; unlimited runs retain context limits.
- The SDK remains responsible for approvals, compaction records, usage and durable
  checkpoints. Explicit invocation compaction overrides are preserved. The adapter
  relies on the installed SDK estimating the request before reading retention
  options; integration tests exercise that ordering with real SDK agents/stores.
- `bounded-evidence-v5` retains the latest structured working plan independently
  of assistant chatter. Old summary formats are accepted as untrusted recollection.
  Summary text never grants approval or certifies verification.
- Context estimates share one characters/3 heuristic. Tool schema serialization is
  cached by schema identity, while messages and descriptions remain freshly measured.
  The transport budget reuses one measurement for prediction and diagnostics.
- Model-facing discovery defaults to ten search matches and path-only listings.
  Explicit larger limits and digests remain available; Workspace API defaults stay
  unchanged.

## Verified behavior

The existing governed OCI driver regression with 18,000-character verbose history
and six retained messages previously expected compaction failure. It now requires
successful verified delivery with the same three approvals and no unauthorized
effects. The test passes with the mock model and simulated OCI adapter.

Additional tests cover large old tool-result eviction, complete retained call/result
pairs, interleaved calls and provider approval references, durable compaction records,
approved and denied resumes, remaining-budget adaptation, schema measurement,
discovery defaults, and structured plans across repeated summaries.

Focused validation: 87 tests passed across nine suites, with 456 assertions.
Local service/client/update socket suites: ten tests passed outside the filesystem
sandbox. Runtime typecheck and production build passed.
Final full suite: 914 passed, one skipped, eight failed (all eight are the compiler
API dependency failures described below), across 136 files.

## Validation boundaries

The initial broad suite and tooling checks encountered an independent installed dependency
problem: `typescript-compiler-api` resolves to a module without compiler APIs such
as `createSourceFile` and `createProgram`. Architecture and Stable API signature
tests therefore cannot pass in this checkout until that dependency is corrected.
The documentation checker also expects OpenAI 0.13.3 and Qwen 0.14.4, whereas the
existing package changes select OpenAI 0.13.4 and Qwen 0.15.0. These dependency and
release-policy changes were not rewritten as part of the context implementation.

RC.4 integration follow-up on 2026-09-22: the compiler API alias was restored to
TypeScript 6.0.3 while the build compiler remains 7.0.2, and the provider pins were
aligned across the manifest, lockfile, documentation and validation policy.
The full suite subsequently passed with 927 tests, one platform skip and no
failures. Architecture, Stable signatures, tooling types, installed-package smoke,
MCP interoperability and required real-Docker OCI isolation also passed. This is
local candidate evidence; release-bound live certification is still required.

No percentage of live token/cost savings is claimed. The 65% target is a policy
parameter, not a measured end-to-end saving. Protected groups may prevent reaching
it, and an irreducibly oversized prompt still fails closed. Estimates are not
provider tokenizers; no model context-window size is inferred.

Dynamic tool catalogs, general parallel tool execution, provider-native compaction,
and model-authored summarization remain separate experiments. The current changes
preserve stable tool catalogs and execution ordering. Evaluate those experiments
on matched tasks/providers with resolution rate, total/uncached tokens, latency,
post-compaction rereads, and cost per verified repair before enabling them.
