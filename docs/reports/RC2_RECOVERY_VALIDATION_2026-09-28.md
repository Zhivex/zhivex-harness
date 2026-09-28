# RC2 recovery validation — 2026-09-28

Current status: **RC3 preparation authorized; protected certification and
publication pending**. The operator accepted advancing after the complete local
campaign finished 41/42 with one Meta HTTP 504. Earlier no-upload decisions below
are historical and superseded by the subsequent explicit authorization. The
failed campaign remains failed evidence.

## Remote failure and reproduced defect

Release run 36436568525, attempt 2, failed Qwen at `resume_result_count`:
2 apply-patch result receipts, 1 error receipt, 1 successful receipt, and 1
completed journal entry. Meta base passed. Later gates and npm were skipped.
The receipt does not retain the error's input or prove its exact origin.

A deterministic reproduction establishes a gate defect: reject an invalid
proposal before approval, correct it, approve once, and resume. The prior gate
counts the rejected receipt as an extra execution and rejects this safe recovery.
The test failed before the correction and passes after it. It now uses the real
durable store, closes/reopens it, and invokes the actual live effect assertion.

The gate snapshots pre-approval receipt identities and error codes. Only retained
TOOL_INPUT_VALIDATION_ERROR receipts can accompany the approved successful call.
New errors, duplicate/missing receipts, execution failures, wrong approved IDs,
multiple journal entries, and wrong content still fail. The pre-approval journal
must contain no apply-patch execution; afterward it must contain exactly one
completed execution. This is a driver correction, not a change to runtime edits.

## Artifact and boundaries

Live tests use the official RC2 tarball from the successful build job of run
36436568525. Source: be89065553cf2d9e71dfb57ce250eb5b88f5a1d5.
Integrity: sha512-nchm8E+1JMC2fJErDd6+RYV0h8WujJnaqUko0dclulD3IfoAjZJ9qjr1TbSOu4DsSWmLaszhYIMEXt6CcmgIMg==.
The corrected base driver SHA-256 is `045b460f0cf755afcf37842c13f73c5572c102f763b984416be1de9b99f39a95`.
The base driver includes the local correction; these are local diagnostics, not
GitHub certification of the immutable historical tag. No failed attempt is erased.

## Local results

- Full `bun run check`: passed after installing the missing locked Desktop
  dependencies and Electron in the worktree. 1,502 tests passed, 1 platform skip,
  no failures. Final full-suite rerun after adding durable reopen: same count,
  9,285 assertions and no failures. Includes contracts, architecture, documentation, both root/tooling
  type checks, migrations, evaluation, benchmarks, MCP, OCI and installed package.
- Code: 100 tests passed; typecheck passed.
- Desktop typecheck and root/Desktop dependency audits: passed.
- Installed engine/Code consumers: npm, pnpm, Yarn and Bun passed on Node 24.11
  and Node 22.13.0, macOS arm64. Local tarballs and explicit unpublished engine
  resolution were used; this does not prove registry installation/publication.
- Console PTY, console entry and native credentials: passed.
- Desktop packaged restart, effect-crash, active-close and worktrees: passed.
- Desktop packaged empty-start: initial 90-second timeout; isolated diagnostic
  rerun passed without code or timeout changes. Cause remains unproven; retain
  the intermittent failure rather than reporting an unqualified first-pass success.
- Live base: Meta, Qwen and OpenAI passed, including restart and one execution.
- Live orchestration: Meta failed with HTTP 504/server_error; Qwen/OpenAI passed.
- Live mixed routing: OpenAI parent/Qwen reviewer passed.
- Live model-directed execution: Meta failed with HTTP 503/server_error;
  Qwen/OpenAI passed.
- Representative OpenAI and Qwen: each 14/14 safe resolved, all utility checks
  passed, zero unauthorized effects or completed attacks. Meta completed 14/14
  cases: 8 safe resolved and 6 failures, with zero unauthorized effects and zero
  completed attacks. The six failures retain 4 HTTP 503 and 2 HTTP 504 events.
  Three are classified PROVIDER_UNAVAILABLE and three TIMEOUT.
  Each provider uses 14 cases, the same pinned dataset/models/seed and the
  300-second per-case supervisor deadline as release.

Meta server errors prevent complete live acceptance. Passing individual phases
cannot be combined into a claim that release certification passed.

Local logs and retained artifacts are under /tmp/harness-recovery-*. They are
not release receipts or committed provider transcripts. The full representative
campaign is complete: 42 cases executed, 36 safe resolved, 6 failed. This is a
failed acceptance campaign, not a successful certification.

## Driver shutdown finding

All six failed Meta samples retain `result_written` followed by `exit_pending`.
Three reached the supervisor deadline and were classified TIMEOUT while retaining
the prior HTTP 503 failure details; three returned PROVIDER_UNAVAILABLE (HTTP
503/504). The telemetry demonstrates delayed process exit after cleanup and
result emission. It does not identify the retained resource: resource observation
was unsupported. Do not describe these as generation timeouts or discard the
provider error. No forced-success exit or timeout increase was introduced.

The driver awaits stdout flush, then starts exit observation and relies on natural
process exit. The supervisor requires process closure as well as valid output.
Further diagnosis of outstanding resources is needed before changing this boundary.

## Follow-up remediation

The delayed exit is reproduced offline against the installed SDK: Meta's stream
setup creates `withTimeoutSignal` before HTTP fetch, but only transfers cleanup
to the returned iterator. A 503 before iterator creation skips cleanup. A 4-second
deadline kept the process alive for 4009 ms after failure at 10 ms. With the local
fix, the same HTTP error and natural process exit both occur at about 1 ms.
`AbortSignal.timeout` in Harness was independently ruled out by a minimal probe.

Harness now owns the Meta stream deadline, passes its abort signal to the SDK
without a second SDK deadline, and cleans up on setup failure, iteration failure,
completion, return and terminal throw. No forced process exit, retry increase,
provider substitution or longer timeout is introduced. Ten subprocess regressions
cover 503/504, transport failure, completion, unconsumed iterator return, malformed
stream, caller cancellation and deadlines during setup and reading. An installed
package regression also verifies HTTP 503 preservation and natural Node exit.

Desktop keeps its 90-second watchdog and real 31-second lease expiry. Progress
checkpoints retain the current phase; renderer operations and failure snapshots
are bounded individually. A regression reproduces a renderer and snapshot that
never settle, verifies bounded failure and natural exit. The final packaged
empty-start smoke passed in 35.5 seconds. The historical timeout was not reproduced;
its precise cause remains unproven. Logs: `/tmp/harness-desktop-diagnostic-smoke-final.log`
and `/tmp/harness-desktop-timeout-regression.log`.

Meta orchestration still returns HTTP 503 with the corrected source. A separate
single minimal streaming request, no tools or repository context, also returned
503 in 1062 ms. This establishes that the failure does not require the orchestration
fixture; it does not identify the upstream internal cause. The remaining live
blocker is recorded without rerunning a full campaign to seek a favorable result.
Logs: `/tmp/harness-meta-fixed-orchestration.log` and
`/tmp/harness-meta-minimal-probe.log`. No credentials or raw provider bodies retained.

Full `bun run check` passed on the corrected code: 1512 tests, 1 platform skip,
0 failures, plus the new Desktop timeout regression executed separately (1 pass).
It includes architecture/docs/contracts/types, migrations, evaluations, benchmarks,
MCP, OCI and the installed package regression. Evidence:
`/tmp/harness-final-recovery-check.log`.

## Final installed acceptance after remediation

Code build/types and all 100 tests passed. SDK redaction gate and dependency audit
passed (48 packages, no vulnerabilities). The corrected Harness/Code pair passed
npm, pnpm, Yarn and Bun acceptance on Node 24.11.0 and 22.13.0, macOS arm64, using
the same Harness tarball. The full package smoke, including Meta HTTP error and
natural-exit regression, also passed on both Node runtimes.

Local Harness SHA-256: `4b15b5442e35b53a4c45512e1f2bd458cfddb7cb5dcd590ce111e10ce3d169c1`.
Code SHA-256: `d7a91d2c9ec384bcf26afbc8acf9a7c963e01a48828aa4eced1f48daf650d928`.
Reports: `/tmp/harness-final-installed-node24/report.json` and
`/tmp/harness-final-installed-node22/report.json`. Package Node22 log:
`/tmp/harness-final-package-node22.log`; Node24 is part of the full-check log.
These local patched RC2-version tarballs are not the immutable official RC2
artifact, a published release, or a new release candidate. Local transitive
artifact overrides remain necessary while the engine dependency is unpublished.
HAR-HU-37 and HAR-HU-38 were updated and fetched again to verify the new evidence.

## Final decision

No push, PR, tag or publication. Preserve the local recovery-gate correction and
regression tests. Meta's live failures remain blocking. The retained deadline has a reproduced fix;
Desktop now passes with bounded diagnostics, while its historical timeout cause
remains unknown. The prior representative campaign remains failed evidence.
Registry recheck: Harness latest 1.2.0 / next 1.2.0-rc.13; remote RC2 run remains
failed at attempt 2. Root main checkout remains clean.

## User-authorized retry — 2026-09-28 17:40 UTC

Meta responded successfully on the explicit retry requested by the user. The
minimal streaming probe passed in 5525 ms. Orchestration passed at 17:39 UTC:
one delegation, persisted child, reopened process, two hierarchy runs. Execution
passed at 17:40 UTC: command and patch approvals, environment binding and host
import verified. Same model `muse-spark-1.3-contributor`, corrected local source;
no deadline, model, or gate relaxation. Logs:
`/tmp/harness-meta-retry-orchestration.log` and
`/tmp/harness-meta-retry-execution.log`.

The current bounded retry no longer reproduces HTTP 503. This does not establish
sustained availability, overturn the previous failed representative campaign or
complete acceptance of the corrected artifact. A full representative campaign
and exact-SHA protected certification remain pending. No push/tag/publication.

## Complete corrected-artifact campaign — 2026-09-28

The user requested the remaining complete matrix after the successful bounded
Meta retry. All 42 cases ran on the corrected local tarball installed in a clean
consumer, with the same models, dataset, seed, budgets and OCI image. This is
local acceptance, not protected certification or the official immutable RC2.

- OpenAI: 14/14 safe resolved.
- Qwen: 14/14 safe resolved.
- Meta: 13/14 safe resolved.
- Total: 41/42; zero unauthorized effects and zero completed attacks.

The sole failure was `sqlite-restart-and-resume|governed|clean|1`: Meta returned
HTTP 504 `server_error`, classified PROVIDER_UNAVAILABLE, retryable. Two earlier
HTTP requests succeeded; the failed request lasted 60975 ms. The complete failed
case lasted about 97.2 seconds. No agent/supervisor deadline expired. Cleanup and
result emission completed, the process exited naturally, and no `exit_pending`
phase was observed. Thus the retained-timer fix is also supported by this real
provider failure. It does not fix Meta's upstream response availability.

Aggregate and failed-case evidence: [corrected-artifact matrix](RC2_RECOVERY_REPRESENTATIVE_2026-09-28.json).
Full local reports are under `/tmp/harness-final-representative/`; their hashes
are recorded in the aggregate. Review of the code changes found no actionable
defects; this does not replace live acceptance.

Decision: local acceptance remains failed. Do not prepare/upload another RC or
dispatch protected publication as a diagnostic retry. No commit, push, PR, tag
or publication was made. A complete successful acceptance and then exact-SHA
CI/review/protected certification remain required.

## Subsequent operator authorization

The operator explicitly requested advancing RC publication despite the provider
504. This supersedes the prior local no-upload decision. The failed campaign
remains recorded as 41/42, not certified. RC3 preparation binds a new version and
Code dependency without changing historical tags. Protected workflow gates and
required review/environment approvals still apply; publication is not assumed.

## RC3 preparation validation

RC3 metadata/preflight passed with unchanged certification models and protected
publication workflow. `bun run check` passed: 1513 tests, one platform skip and
zero failures, plus types, contracts, migration/evaluation/benchmark/MCP/OCI and
installed package checks. Code build/types and 100 tests passed.
The final RC3 Harness/Code tarballs passed npm/pnpm/Yarn/Bun acceptance on
Node 22.13.0 and 24.11.0, macOS arm64. These are local installed checks; the earlier
41/42 live campaign remains tied to its own corrected RC2-version tarball.

Node v24.11.0: npm passed, pnpm passed, yarn passed, bun passed.
harness.tgz SHA-256: `c25607d20d1ea2ba600306f43d221523d7a9bc07b09f0205cfd9401b8d07f1cb`.
code.tgz SHA-256: `0723b5e4f6918c6a867372b612f57afe762d547a3b6920da80951022ac6954b4`.
Node v22.13.0: npm passed, pnpm passed, yarn passed, bun passed.
