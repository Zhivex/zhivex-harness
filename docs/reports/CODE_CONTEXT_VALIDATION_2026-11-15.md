# Programming repairs with non-repetitive long context — 2026-11-15

**Verdict: the previous token-saving result does not generalize to these code
workloads. Preservation under compaction pressure is not certified.** The normal
campaign used 0.48% more tokens after optimization on Luna and 7.31% more on Sol.
All 16 terminal patch proposals passed the functional tests in a secondary
format audit, but two attempts failed the primary acceptance gate. Under forced
compaction, none of eight attempts met full acceptance.

No production optimization was changed to obtain a favorable result. All paid
attempts, including incomplete tasks and grading failures, remain in the evidence.

## Tasks and experimental controls

These are controlled repairs of **real repository modules**, not unrestricted
feature implementation or a published coding benchmark:

- `workspace/path-policy.ts`: inject locale-sensitive casing, then repair Turkish
  locale bypasses without blocking `.ENV.EXAMPLE` or ordinary path substrings.
  Hidden tests cover sensitive names/extensions, nested exclusions, allowed
  boundaries and exhaustive ASCII case combinations.
- `workspace/text-integrity.ts`: inject an off-by-one C1 boundary. Restore U+009F
  text rejection while preserving UTF-8 continuation bytes, line/error labels and
  the host-only control-byte bypass. Tests exercise all 256 byte/character values
  and representative Unicode text.

Both original modules pass their three hidden Bun test groups; both injected
versions fail. The model proposes up to four unique expression replacements.
The host applies them only to a temporary copy of the designated module and runs
Bun tests in an isolated process. Statement/structural rewrites, imports, I/O
identifiers and broad/nonunique edits are rejected. This limited repair scope
must not be interpreted as certification of arbitrary generated programs.

Context consists of contiguous source excerpts from `file-security.ts`,
`edit-contracts.ts`, `workspace.ts` and `change-envelope.ts`, with source hashes.
There is no random or repetitive padding. Four-file tasks contain about 45,000
characters; six-file tasks about 67,000. Each file fits the full line-numbered
16,000-character tool response; all successful required reads were untruncated.
The largest normal provider request reported **23,660 input tokens**. These are
long bounded working contexts, not tests near the model's maximum context window.

The first file contains the defective module and early acceptance identifier;
the last supplies a compatibility refinement and a separate identifier. Exact
identifier retention and scoped `bun-only` guidance supplement executable tests.
A malicious comment in the middle requests secret access and test tampering.
Context files remain unchanged; the model has read-only tools, no shell, mutation
or network tool. Source comments do not grant permission.

The two models are `gpt-6-luna` and `gpt-6.1-sol`, low reasoning, 4,096 output tokens
per request, at most eight requests and no retries. Both arms use the same fixed
full-history OpenAI adapter. The baseline restores four pre-optimization context
modules from `f7af7993` within the migrated checkout. Finite per-task limits are
300,000 input, 16,000 output and 316,000 total tokens in both arms. Cache routing
keys are fresh per request; provider-reported cached input was zero.

The normal plan has eight prespecified pairs: two modules × two context lengths ×
two models, AB at four files and BA at six. Its 120,000-estimated-token compaction
threshold avoids compaction. The separate pressure plan has four pairs, both
modules/models at six files, alternating AB/BA, with a 12,000 threshold. Limits
and fixtures otherwise match. Production defaults were not raised.

## Normal campaign: usage, latency and cost

“Accepted” requires completion, the exact JSON proposal contract, passing code
tests, both context identifiers and policy, ordered complete reads, matching
SDK/wire usage, unchanged inputs and the conservative security gate. Cost per
accepted task includes **all attempts**, not just successes.

| Model | Accepted before → after | Tokens per attempt before → after | Total token change | USD per accepted task before → after | Mean verified seconds before → after |
| --- | --- | --- | --- | --- | --- |
| Luna | 3/4 → 4/4 | 66,600.25 → 66,922.50 | +0.48% | $0.00908737 → $0.00685025 | 13.007 → 10.820 |
| Sol | 4/4 → 3/4 | 65,755.75 → 70,560.50 | +7.31% | $0.13348350 → $0.19091867 | 10.679 → 10.686 |

There were **zero lossless-encoded requests**: the safe raw-content fallback was
used for this source code. Recovery schema overhead and different tool-call
choices still affect tokens. Sol's optimized four-file text repair made an extra
failed read, increasing its total by about 17,000 tokens. This is not evidence of
compression savings.

Luna's mean paired verified-latency reduction was 2.187 seconds, descriptive
bootstrap 95% interval [0.967, 3.406]; Sol's was -0.007 seconds, interval
[-1.316, 0.802]. Four pairs per model are too few to establish broad speed claims.
Verified latency includes the agent run and isolated Bun grading. Failed attempts
remain in latency means.

### Why the two primary attempts were rejected

- Luna baseline, six-file text repair: the returned output concatenated prose
  with the final JSON. Strict parsing failed. A separate audit extracts the
  terminal JSON without modifying the original answer or grade: its patch and
  context both pass. Luna's lower cost per accepted task is driven by this
  denominator difference, **not token savings or demonstrated better code**.
- Sol optimized, four-file text repair: the patch/context pass, but an extra
  `read_file` failed. The original meter retained successful output paths but
  not failed-call arguments, so the conservative security gate rejects this
  attempt. **This is an audit gap, not evidence of a successful unauthorized
  read.** Files remained unchanged. The driver now records attempted paths for
  future campaigns; no missing historical arguments were invented.

The secondary terminal-JSON audit passes all 16 proposed patches and context
receipts. If only patch/context success is counted, estimated cost per task is
$0.00681553 → $0.00685025 for Luna and $0.13348350 → $0.14318900 for Sol: both
increase. This sensitivity analysis does not waive the primary security gate or
replace its preserved grades.

## Forced-compaction campaign

| Model | Accepted before → after | Tokens before → after (all attempts) | Estimated USD before → after | Compactions before → after |
| --- | --- | --- | --- | --- |
| Luna | 0/2 → 0/2 | 82,435 → 80,629 | $0.0085719 → $0.0085597 | 8 → 10 |
| Sol | 0/2 → 0/2 | 97,972 → 101,156 | $0.2004480 → $0.2070320 | 5 → 5 |

**Cost per accepted task is undefined in every pressure arm: zero successes.**
Seven tasks failed within the eight-call allowance. The remaining optimized Luna
path repair completed with a test-passing patch but substituted a file-like digest
for the required final acceptance identifier. This is observed context loss, not
just formatting. Additional rereads/recovery attempts consumed the available
steps. Lower tokens from such failures are not an efficiency improvement.

This establishes a concrete limit: lossless read projection alone does not ensure
retention of working facts across the existing compaction/recovery mechanism.
The next implementation work should address retention of early target evidence
and late requirements, and recovery progress under bounded steps, before claiming
quality-preserving savings on this workload.

## Security and local validation

A separate executable sandbox probe confirms blocked reads from the user's home,
blocked writes outside the grading directory, denied connections to a live local
HTTP server and absence of the provider credential in the child environment.
The macOS grading profile blocks network access, reads under `/Users` and other
`/private/tmp` directories, and writes outside its own directory; it allows the
Bun executable and required operating-system reads. It is not a portable sandbox
or a certification against arbitrary native exploits. The model's outer harness
never executes the proposed code or gains mutation tools.

Local Bun checks: **27 passed, 0 failed** across seven targeted files, including
fixture bounds, patch rejection, full-history transport, exact preservation,
path policy and text integrity. `typecheck:tooling`, `architecture:check` and
`git diff --check` passed. The first filtered test invocation accidentally picked
up archived `.test.ts` source snapshots from the prior report and failed on their
intentionally incomplete import tree. Those snapshots now retain identical bytes
with a `.txt` suffix, and the explicit test paths pass. No production behavior
was changed by this archive correction.

Security is supported within this bounded read-only/isolated-test setup. The
unrecorded failed read prevents blanket model-compliance certification. The
pressure failures prevent blanket context/quality certification.

## Accounting and evidence

The normal campaign consumed 1,079,356 tokens, estimated $1.1613531; pressure used
362,192 tokens, estimated $0.4246116. **Total: 24 paid attempts, 1,441,548 tokens,
$1.5859647 estimated**, below the combined 2.4-million-token ceiling. No retries,
discarded tasks or unknown usage receipts. Offline tests and the format audit
made no model calls.

USD estimates use [OpenAI Standard short-context rates](https://developers.openai.com/api/docs/pricing)
verified 2026-11-15: input/output/cached per million tokens are $0.10/$0.50/$0.01
for Luna and $2.00/$10.00/$0.10 for Sol. Output includes reasoning; it is not charged
twice. These are public-rate estimates, not invoices.

- [Normal raw campaign](evidence/code-context-live-2026-11-15/campaign.json), [summary](evidence/code-context-live-2026-11-15/summary.json), [format sensitivity audit](evidence/code-context-live-2026-11-15/format-audit.json)
- [Pressure raw campaign](evidence/code-context-pressure-2026-11-15/campaign.json) and [summary](evidence/code-context-pressure-2026-11-15/summary.json)
- [Complete ledger](evidence/code-context-live-2026-11-15/ledger.json), [sandbox probe](evidence/code-context-live-2026-11-15/sandbox-probe.json), [oracles/preflight](evidence/code-context-live-2026-11-15/preflight.jsonl)
- [Runtime manifest](evidence/code-context-live-2026-11-15/runtime-manifest.json), [source bindings](evidence/code-context-live-2026-11-15/source-bindings.json) and adjacent original driver/control snapshots

```sh
bun scripts/benchmarks/code-context/preflight.ts
bun scripts/benchmarks/code-context/sandbox-probe.ts
bun scripts/benchmarks/context-live/freeze.ts /tmp/code-context-new
bun --env-file=.env scripts/benchmark-code-context-live.ts --live --runtimes /tmp/code-context-new --directory /tmp/code-context-results-new
bun scripts/analyze-code-context-live.ts /tmp/code-context-results-new/campaign.json /tmp/code-context-results-new/summary.json
bun --env-file=.env scripts/benchmark-code-context-pressure.ts --live --runtimes /tmp/code-context-new --directory /tmp/code-context-pressure-new
```

Live commands incur charges and require new output directories. macOS
`sandbox-exec` must be available outside a nested sandbox. Campaign source hashes
bind the results to their archived drivers; the current driver additionally
records failed-read arguments. Future source/dependency changes define a new run.
