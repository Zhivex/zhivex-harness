# Changelog

All notable changes to Zhivex Harness are documented in this file.

The project follows Semantic Versioning. During `0.x`, minor releases may change user-facing contracts when the change is documented with a migration note. Patch releases remain backwards compatible bug fixes.

## 1.0.0-rc.11 - 2026-09-01

### Fixed

- Keep the governed Qwen representative driver on its certified Responses path instead of selecting Chat through an incompatible transport-level `maxTokens` option; the same output limit remains enforced by the Harness durable token guard before and after each provider step.

### Changed

- Record the immutable, unpublished RC.10 attempt as failed after its exact tarball passed artifact binding: Meta completed 14/14 representative cases, Qwen completed 13/14, and an OpenAI account-funding issue surfaced as retryable HTTP 500 failures across live and representative gates; npm publication remained skipped.
- Extend the representative release matrices through `v1.0.0-rc.11`; RC.11 remains pending until OpenAI recovers and the distinct candidate completes every protected gate.

## 1.0.0-rc.10 - 2026-09-01

### Fixed

- Isolate the non-release early-diagnostic fixture from release-bound environment variables, so the test remains hermetic when `bun test` runs inside the validation job while real incomplete diagnostic bindings continue to fail closed.
- Allow the immutable readiness ledger to record a deterministic pre-artifact failure with an explicit null artifact digest and `not-run` live certification instead of inventing an artifact identity.

### Changed

- Record the immutable, unpublished RC.9 attempt as failed during deterministic validation before packing: one environment-sensitive test failed, no release tarball was created, every live/representative gate was skipped, and npm publication was not dispatched.
- Extend the representative release matrices through `v1.0.0-rc.10`; RC.10 remains pending until its distinct commit and annotated tag complete the full protected workflow.

## 1.0.0-rc.9 - 2026-09-01

### Fixed

- Build `dist/` before the manual tag-bound live-certification workflow packs and inspects the candidate, preventing a source-only tarball from failing artifact binding before OCI and provider gates can run.

### Changed

- Record the immutable, unpublished RC.8 attempt as failed at artifact binding: exact-tag readiness passed, but OCI and every provider gate were skipped, no diagnostic artifact was produced, and npm publication was not dispatched.
- Extend the representative release matrices through `v1.0.0-rc.9`; RC.9 remains pending until its exact tag completes protected certification.

## 1.0.0-rc.8 - 2026-09-01

### Fixed

- Complete HAR-HU-01 release diagnostics without relaying child stdout/stderr: every live gate now persists only strict sanitized outcomes identified by provider or phase, and the final summary remains fail-closed.
- Record a missing provider credential as that provider's configuration failure so the remaining selected providers still execute, and include OCI image preload as an independent diagnostic gate instead of short-circuiting the matrix.

### Changed

- Refresh the coordinated Zhivex dependency set to the current published versions verified for this candidate: `@zhivex-ai/core@1.11.0`, `@zhivex-ai/qwen@0.11.1`, and `@zhivex-ai/gemini@0.11.0`, while retaining current Agents `1.3.0`, Meta `0.2.2`, OpenAI `0.10.0`, exact package pins, and one Core override across every adapter.
- Keep the Harness Qwen tool-call-ID normalizer as a defense-in-depth boundary while adopting the adapter's current missing/placeholder-ID normalization, Responses continuation correlation, and Bun realtime frame-limit correction.
- Authorize `v1.0.0-rc.8` in the representative evaluation matrices and record it as pending. No live-provider, representative-repository, release-artifact, registry, or provenance result is claimed before the exact candidate completes those gates.

## 1.0.0-rc.7 - 2026-08-25

### Fixed

- Keep `@zhivex-ai/core@1.10.0`, `@zhivex-ai/agents@1.3.0`, and `@zhivex-ai/openai@0.10.0`, while restoring `@zhivex-ai/qwen@0.10.2`, the last adapter that passed the complete release-bound Qwen representative matrix. Qwen `0.10.3` failed closed before the Harness durable tool-call-ID normalizer could recover the affected turns.

### Changed

- Record the immutable, unpublished RC.6 attempt as failed after exact-artifact and release-bound live certification passed, while Qwen resolved only 12/14 representative cases in both the original protected run and one retry; npm publication remained skipped.
- Extend the representative release matrix through `v1.0.0-rc.7`; because RC.6 cannot count toward GA, a later independent passing candidate will still be required before stable promotion.

## 1.0.0-rc.6 - 2026-08-25

### Fixed

- Upgrade the coordinated Zhivex SDK batch to `@zhivex-ai/core@1.10.0`, `@zhivex-ai/agents@1.3.0`, `@zhivex-ai/openai@0.10.0`, and `@zhivex-ai/qwen@0.10.3`, retaining exact pins and one Core override across every provider adapter.
- Preserve the sanitized OpenAI Responses tool-call diagnostic and retryability from durable SDK failures in Time-to-Safe-Fix evidence without retaining raw arguments, provider payloads, or error messages.
- Complete the governed representative driver from the signed, journaled `apply_environment_patch` receipt after its separate edit, verifier, inspection, and import approvals, avoiding a redundant final provider turn after the authorized repair is already durable.

### Changed

- Record the immutable, unpublished RC.5 attempt as failed after exact-artifact validation and release-bound live certification passed but OpenAI resolved only 13/14 representative cases.
- Advance the next candidate to `v1.0.0-rc.6`; because RC.5 cannot count toward GA, a later independent passing candidate will still be required before stable promotion.

## 1.0.0-rc.5 - 2026-08-24

### Fixed

- Replace missing, whitespace-only, and legacy numeric Qwen streaming tool-call IDs with deterministic, turn-durable IDs before agent state can observe them; preserve valid provider IDs and reject real duplicates fail-closed.
- Persist a bounded failure origin and allowlisted provider diagnostic code in Time-to-Safe-Fix failures, including through typed Harness error causes, without retaining provider messages or raw output.

### Changed

- Record the immutable, unpublished RC.4 attempt as failed after its release-bound live-provider gate passed but Qwen resolved only 13/14 representative cases.
- Extend the representative release matrix through `v1.0.0-rc.6`; RC.5 and RC.6 must both pass independently before GA.

## 1.0.0-rc.4 - 2026-08-24

### Fixed

- Preserve stable typed Harness failure `code`, `category`, and `retryable` metadata alongside Time-to-Safe-Fix semantic classification, so transient provider and OCI execution failures remain machine-classifiable without retaining raw error text.

### Changed

- Record the immutable, unpublished RC.3 release attempt as failed at the representative-evaluation gate after exact-artifact, release-bound live certification, and the Meta matrix passed.
- Extend the representative release matrix through `v1.0.0-rc.5` because RC.1, RC.2, and RC.3 cannot count toward the two-passing-candidate GA requirement.

## 1.0.0-rc.3 - 2026-08-24

### Fixed

- Persist bounded structured diagnostics for failed representative-provider cases while continuing to exclude raw prompts, model output, raw provider error text, and workspace contents from release artifacts.
- Record whether the release-bound live-provider gate passed or failed independently from other failed release gates, and reject contradictory ledger evidence.

### Changed

- Record the immutable, unpublished RC.2 release attempt as failed at the representative-evaluation gate after exact-artifact and release-bound live certification passed.
- Extend the representative release matrix through `v1.0.0-rc.4` because RC.1 and RC.2 cannot count toward the two-passing-candidate GA requirement.

## 1.0.0-rc.2 - 2026-08-23

### Fixed

- Normalize missing or whitespace-only Qwen tool-call IDs at the built-in provider boundary before durable agent state, approvals, or tool journals can observe them; preserve valid provider IDs and reject duplicate IDs fail-closed.

### Changed

- Record immutable release attempts that fail protected gates without claiming npm publication or provenance, exclude them from passing GA evidence, and require two later passing candidates before stable promotion.
- Extend the representative release matrix through `v1.0.0-rc.3` because the failed, unpublished RC.1 attempt cannot count toward the two-candidate GA requirement.

## 1.0.0-rc.1 - 2026-08-23

### Added

- Add a machine-checked 1.0 public API/CLI/schema baseline, support matrix, threat/control map, deprecation and rollback policies, representative-evidence schema, and a fail-closed GA readiness ledger.
- Add an explicit config schema `4` to `5` migration helper that preserves the older authority boundary by disabling project context and OCI shell exposure unless the operator opts in after review.
- Add stable machine error codes with typed configuration/CLI usage errors and compile a TypeScript consumer against the installed release tarball.
- Add schema-1 parsers and golden fixtures for public JSON/JSONL output, a command-specific CLI option manifest, and provider-free logical SQLite state status/export/import commands.
- Add byte-for-byte SQLite migration fixtures generated from the integrity-verified published `0.10.0` and `0.11.1` artifacts and verify them through current run and session APIs.
- Add a seven-repository, 14-run representative matrix with strict per-case evidence generation, sanitized cross-provider assembly, and a protected Meta/Qwen/OpenAI release job that blocks npm publication.
- Add a strict release-candidate security-review schema covering every control, trust boundary, authority-bearing tool, finding, reviewer, artifact binding, and remotely verified CI/CodeQL/release workflow.

### Changed

- Allow protected `1.0.0-rc.N` artifacts only on npm `next`, keep stable releases on `latest`, and reject version/channel drift before publication.
- Bind each GA release-candidate record to a distinct annotated tag, main-reachable commit, published npm integrity, SLSA provenance statement, and successful release workflow; require every declared provider/scenario on both candidates, verify the evaluation workflows through GitHub, and require a concrete security-review artifact.
- Expose CLI command/subcommand constants as the source for the frozen command manifest and document previously omitted child-budget options in help output.
- Emit a distinct compact `run-stream-result` JSONL terminal record, keep machine errors message-free, and delay terminal JSONL output until asynchronous persistence/environment cleanup succeeds.
- Run installed-package smoke against the exact inspected tarball in CI, reject SQLite WAL/SHM sidecars, and clean `dist` before every build.
- Classify all 213 runtime and 166 type exports explicitly as Stable, Beta, or Experimental, and compare the complete partition with the installed tarball namespace and declarations.
- Bind every Stable runtime and type export to a reproducible declaration-closure hash and verify that signature snapshot against source-emitted and installed-tarball declarations.
- Keep Gemini explicitly provisional and outside the 1.0 certified cohort; accept later corrective RCs only as a contiguous sequence after the required RC.1 and RC.2.

### Security

- Stream integrity-pinned historical npm archives directly into an isolated extractor instead of persisting network bytes, constrain MCP authentication to canonical credential headers backed by dedicated `ZHIVEX_MCP_*` variables, publish state backups atomically without clobbering existing targets, and reject orphaned active leases for runs being imported.

### Migration

- Existing schema `5` configuration is unchanged. Call `migrateHarnessConfigInput` for an explicitly versioned schema `4` input; the pure migration does not read environment variables or filesystem state. Paused approvals remain bound to the exact older artifact and are never rewritten.
- Existing schema-1 JSON observers may accept additive fields, but JSONL consumers must recognize the distinct `run-stream-result` and `run-stream-error` terminal kinds. The literal durable `userId` value `"*"` is now rejected because it is reserved for the absent-user scope marker.
- Rename MCP credential variables to the `ZHIVEX_MCP_*` namespace; HTTP `headerEnv` entries now accept only `authorization` and `x-api-key`.

## 0.11.1 - 2026-08-23

### Changed

- Make provider live certification a fail-closed dependency of the publish job and bind manual certification runs to an explicit release tag.
- Remove release-version defaults from GitHub workflow inputs. Maintainers enter the annotated tag at dispatch, and release readiness validates it against the single version source in `package.json`.
- Keep release-artifact transfer actions pinned to immutable commit SHAs while allowing Dependabot SHA upgrades, and represent successful remote tag-bound certification explicitly in the release-status schema.
- Add a mutable machine-readable repository release-status record, keep it outside immutable npm artifacts, and validate public documentation, release gates, and repository security configuration against it.
- Bound installed-package smoke subprocesses by time and captured output so a stalled child process cannot hang release validation indefinitely.
- Keep public documentation consistent with candidate and published artifact state while preserving live-provider certification as a separate evidence boundary.
- Retry only transient HTTP failures in the opt-in base provider smoke, using fresh temporary state and a bounded three-attempt schedule; contract and approval failures still fail immediately.
- Preserve transient provider status from failed agent outputs before release-smoke contract assertions so retryable 429/5xx responses reach the bounded retry loop.
- Mark create-only `expectedDigest: null` as an explicitly required tool-schema field and reinforce that contract in live certification prompts for providers that otherwise omit null-valued arguments.
- Record current worktree live evidence separately from release-bound certification: the certified cohort passed every local gate, while Gemini Flash 3.7 passed base editing and delegation but remained blocked on provider quota/capacity during OCI execution.

### Security

- Add CodeQL, Dependabot, CODEOWNERS, and documented public-repository security controls. GitHub-side controls that are free for public repositories are enabled; optional cost-bearing analysis remains disabled and explicitly recorded. Live provider credentials are scoped only to the final provider-call step rather than checkout, setup, dependency installation, or deterministic validation.
- Bind workspace, context, OCI, change-envelope, and release-artifact reads to bounded regular-file descriptors that reject symbolic links, hard-linked OCI exports, special files, and concurrent content replacement.
- Create SQLite state files and benchmark canaries exclusively, stage release archives from the exact inspected bytes, pin registry identity independently of package metadata, and classify adversarial benchmark failures with a linear complete-token scanner.
- Recover canonical `.cleanup-<artifact>-<uuid>` OCI artifact directories after interrupted cleanup without weakening inode and metadata revalidation.

### Migration from 0.11.0

No configuration, SQLite, approval, or execution-policy migration is required. Existing `0.11.0` state remains compatible; this patch tightens failure classification, cleanup recovery, and release boundaries.

## 0.11.0 - 2026-08-21

### Added

- Add a dependency-free terminal presentation layer with sanitized/redacted activity events, complete governed approval cards, and `y`/`n`/`v`/`q` decision handling that never partially resolves a durable approval batch.
- Add `/pending`, `/approve`, and `/deny` so a recovered chat session can inspect and resolve its durable approval without leaving the console; persisted provider, routing, context, and OCI policy are restored before resumption.
- Add bounded project context/rule discovery, progressive `SKILL.md` disclosure, and version-bound trusted application lifecycle hooks. Repository configuration cannot register executable host hooks.
- Add opt-in `run_environment_shell` through `--execution oci --oci-shell ask`. The exact script is approval-bound and interpreted only by `sh` inside the no-network OCI snapshot; host mutation still requires the separate content-bound import approval.

### Changed

- Advance resolved config schema to `5` and the OCI execution-policy fingerprint to `2026-08-21-v4`; complete paused `0.10.0` work with the published artifact rather than rebinding it to the changed tool/context surface.
- Bound the live reviewer-delegation fixture to one read-only child tool call against a temporary repository with a known diff, avoiding provider-specific false failures caused by asking a reviewer to inspect an empty non-Git workspace.
- Align the default mixed-provider live route with the certified cohort (OpenAI parent, Qwen reviewer); Gemini routing remains an explicit provisional certification target.
- Await asynchronous harness shutdown throughout release, evaluation, smoke, and test callers so lifecycle hooks and OCI cleanup complete before process exit.
- Emit `run-finished` only for terminal run states, and have `zhx doctor` load and validate configured project context before reporting readiness.

### Migration from 0.10.x

- Change schema-version-pinned configuration from `schemaVersion: 4` to `5`. Existing SQLite state remains readable, but paused approvals created by `0.10.x` must be completed or denied with the matching `0.10.x` artifact because context, hook, tool, and execution-policy fingerprints changed.
- Await `harness.close()` in library cleanup paths. Lifecycle hooks can make shutdown asynchronous even when no execution environment is active.
- Project context discovery is enabled by default. Use `--no-project-context` or `projectContext: false` when an embedding must ignore repository instructions; malformed explicit context manifests fail before provider execution.
- OCI shell syntax remains opt-in. Existing OCI configurations keep `shellMode: "deny"`; set `--oci-shell ask` or `shellMode: "ask"` only when exact-script approval inside the no-network container is intended.

### Security

- Shell remains `deny` by default, is unavailable without OCI, never inherits host environment variables, and does not enable container networking. Command entrypoint lists do not claim to constrain every descendant process spawned inside the container.

## 0.10.0 - 2026-08-21

### Changed

- Add path-only topology discovery, a single-attestation warm OCI command path, approved `run_environment_batch` execution for up to 32 allowlisted argv commands, `verify_and_apply_environment_patch`, and the clean-snapshot `verify_and_apply_reviewed_edits` transaction. The latter binds complete digest-bound edits plus verifier argv in one approval, imports only after drift-free verification, and can finish from its journaled receipt without a redundant provider turn. A stale-digest rejection leaves the host untouched, journals the error, and lets the model reread and submit a corrected request through a new approval; other terminal failures remain fail-closed.
- Expand the reproducible workspace and OCI benchmarks with configurable warmups/repetitions, validated success rates, nearest-rank p50/p95/p99 aggregates, topology-only versus digest-bound listing, explicit OCI phase definitions, and end-to-end time to first successful command.
- Add a RepoGuardBench-compatible Time-to-Safe-Fix runner with clean/attacked matrices, direct/governed/optimized profiles, a built-in matched-model OCI driver, per-turn/tool/approval efficiency telemetry, sanitized structured failure codes, strict evidence, safe-resolution scoring, Wilson intervals, matched overhead, a digest/snapshot/hash-locked Node+Python+pytest image contract, separate deterministic and opt-in 12-run live smokes, an opt-in 12-task/three-repetition expanded fixture, and digest-verified sanitized baselines while full reports remain local artifacts. The optimized profile uses a four-tool surface, grouped discovery, and one terminal approved edit-verify-import transaction.
- Preserve external-driver deadline termination as stable, retryable `TIMEOUT` evidence instead of degrading the runner-issued `SIGKILL` to an unclassified failure.
- Make Node.js `>=22.13.0` the primary public runtime for the `zhx`/`zhivex-harness` CLI and library while retaining Bun-compatible imports and Bun-managed contributor tooling.
- Raise Bun contributor tooling to `>=1.4.0`, the first pinned project runtime that exposes the `node:sqlite` backend used by source-checkout tests; CI, release, live-certification, package metadata, and support docs now share that exact minimum.
- Replace `bun:sqlite` with a small `node:sqlite` compatibility layer. It normalizes SQLite `?NNN` placeholders to indexed named bindings so repeated parameters behave consistently on Node 22.13 and newer. Existing `operations.sqlite` files, table names, WAL behavior, permissions, scopes, sessions, runs, approvals, leases, and tool journals remain compatible.
- Replace host `Bun.spawn` calls with bounded argv-only `node:child_process` execution for Git, repository checks, and OCI runtime commands.
- Resolve repository checks from a pinned `packageManager` field or an unambiguous npm, pnpm, Yarn, or Bun lockfile. Repositories without either default to npm; symbolic-link/ambiguous lockfiles and implicit `pre<check>`/`post<check>` hooks fail closed.
- Change the default enforced image to `node:24-bookworm-slim`, the default command allowlist to `node,npm`, and the execution-policy fingerprint to `2026-08-21-v3`. Custom Bun images remain supported when `bun` is explicitly allowed.
- Build the published ESM artifact for Node and certify direct Node CLI/library execution plus a secondary Bun import in the installed-package smoke.
- Export `NODE_ENGINE_RANGE`; retain `BUN_ENGINE_RANGE` as the secondary compatibility contract.

### Migration

- Install Node.js `22.13.0` or newer before invoking the packaged CLI. After publication, `npx --yes --package=@zhivex-ai/harness@0.10.0 zhx --version` is the artifact-bound zero-install path; do not use an unversioned command until the registry `latest` tag is verified.
- Complete or deny paused `0.9.x` approvals with the matching `0.9.x` artifact. The execution policy, default image, and tool fingerprint changed, so `0.10.x` intentionally rejects incompatible resumptions instead of silently rebinding them.
- Existing SQLite state needs no data migration. Bun repositories should declare `"packageManager": "bun@<version>"` or keep one Bun lockfile; custom OCI configurations must include `bun` in their command allowlist and provide an image containing both Node (for the controller) and Bun.
- Rename or fold implicit `pretest`/`posttest`-style hooks into the explicitly reviewed allowlisted script before asking the harness to execute it.

### Performance

- In the bounded two-task local GPT-5.6 Luna smoke after stale-digest recovery was added, all 12/12 matched runs resolved safely with zero completed attacks, unauthorized effects, or environment failures. Observed p50 was 9.50 s direct, 22.20 s governed, and 7.88 s optimized. Optimized averaged 5.32k tokens, three model turns, and one approval round versus 4.16k/4/0 direct and 19.55k/7/3 governed. That is a 17.1% lower observed p50 than direct and 64.5% lower than governed in this four-run-per-profile smoke, not a cross-platform or provider guarantee. A directed OCI test separately proves stale-digest recovery through a second content-bound approval.
- In the current terminal-transaction 12-task, three-repetition local GPT-5.6 Luna matrix, governed resolved 72/72 runs safely (100%; Wilson 95% 94.93–100%) while direct and optimized each resolved 71/72 (98.61%; Wilson 95% 92.54–99.75%), with zero completed attacks and zero unauthorized effects. Safe-run p50 was 9.64 s direct, 17.56 s governed, and 8.49 s optimized; optimized averaged 5.31k tokens, 2.96 model turns, and one approval round. Its observed safe-run p50 was 12.0% lower than direct and 51.7% lower than governed. The optimized miss was a fail-closed stale-digest rejection that left the host unchanged; this remains synthetic local evidence, not a public benchmark score or production guarantee.

## 0.9.0 - 2026-08-20

### Added

- `ChangeEnvelope v1`, a deterministic, agent-agnostic and offline-verifiable change-admission document that binds base/tree identity, exact patch bytes, harness/policy/environment fingerprints, redacted check evidence, expiry, approval references, and optional external attestation references.
- `zhx changes create` and `zhx changes verify` for binding an exact patch artifact and validating integrity, expiry, and caller-supplied preconditions without loading a provider or contacting a network service.
- Bounded `read_files` and `search_many` tools so independent repository lookups share one model/tool round trip and multi-query search reads each candidate file once.
- A reproducible `bun run benchmark:workspace` fixture plus workspace-index and OCI I/O diagnostics.
- A reproducible `bun run benchmark:oci` fixture for first-command, warm no-op, mutation, and snapshot latency.

### Changed

- Workspace pagination now reuses a topology-only, freshness-checked index with binary path lookup. File contents and digests are still read through the race-sensitive stable-read path; structural changes invalidate active cursors.
- OCI snapshots retain metadata rather than the full repository contents in memory, write the immutable base once, and use copy-on-write cloning with a portable copy fallback for the mutable workspace. Patch inspection rereads content only for changed files.
- OCI commands now reuse one paused container per acquired run. Unchanged canonical workspace seals skip export, changed workspaces still publish through a validated atomic staging directory, and failures, background processes, or host-snapshot divergence destroy and reseed the warm session.

### Performance

- On the local 5,000-file benchmark, listing all 25 pages of 200 files decreased from about 3.02 seconds to 0.38 seconds, and the first page decreased from about 118 ms to 42 ms. These figures are development-machine observations, not cross-platform release guarantees.
- On the local 1,001-file Docker benchmark, warm no-op OCI commands decreased from about 838 ms to roughly 0.31–0.37 seconds median. Commands that change the workspace retain the full validation/export path. These figures are development-machine observations, not cross-platform release guarantees.

### Migration from 0.8.x

- Complete or deny paused `0.8.x` approvals with the matching `0.8.x` artifact. The workspace tool contract fingerprint changed to include the new batch tools, so `0.9.x` intentionally refuses to resume those approvals under a different tool surface.
- Configuration schema `4`, the durable store, existing single-file tools, and both CLI executable aliases remain compatible. The OCI policy fingerprint advances because isolation changes from per-tool-call containers to a paused per-run container; complete or deny paused OCI approvals with the matching older artifact. Callers can adopt `read_files`, `search_many`, and change envelopes incrementally.

### Security

- Change-envelope verification proves canonical integrity, rejects future creation/check evidence, enforces expiration, exact patch binding, and explicit preconditions only. Approval and external-attestation authenticity is reported as `not-verified` and requires an external trust verifier.
- The workspace index never caches file contents or content digests. It validates directory and ignore-rule fingerprints before reuse, rejects stale topology-bound cursors, and invalidates after every harness mutation and declared check.
- Warm OCI reuse never mounts the durable host snapshot writable. Commands are serialized; background processes fail closed; `/tmp` is cleared after success; and any failed or divergent session is destroyed before a later command reseeds from the last published snapshot.

## 0.8.0 - 2026-08-20

### Changed

- The coordinated SDK dependency batch now resolves one `@zhivex-ai/core@1.7.0` runtime with Agents `1.2.0`, Meta `0.2.2`, Qwen `0.10.2`, OpenAI `0.9.6`, and Gemini `0.10.5`.
- Approval instructions now tell models to call the gated tool with reviewed arguments so the runtime can pause, instead of asking the operator for approval in prose before emitting the tool call.
- OpenAI is now GPT-5.6-first, defaults to `gpt-5.6-luna`, and exposes `gpt-5.6-terra` and `gpt-5.6-sol` as explicit model choices. All three passed the local base certification gate, while unpublished worktree evidence remains separate from release certification.

### Migration from 0.7.x

- OpenAI runs without an explicit `--model` now resolve to `gpt-5.6-luna` instead of `gpt-5.4`. Pin the prior model explicitly before upgrading if a workflow depends on it; GPT-5.6 availability remains organization-dependent during limited preview.
- Resolve or deny paused `0.7.x` approvals with the matching `0.7.x` artifact before upgrading. Harness-version binding intentionally rejects those resumes under `0.8.x`.

## 0.7.0 - 2026-08-20

### Added

- The short `zhx` executable while retaining `zhivex-harness` for command compatibility.
- A durable interactive console backed by a scoped SQLite session index, including session list/inspect/rename/fork/archive and `/provider`, `/model`, `/route`, `/status`, `/diff`, `/review`, `/resume`, `/compact`, `/new`, and `/rename` commands.
- A public, validated, injectable provider registry with built-in Meta, Qwen, OpenAI, and provisional Gemini registrations. Gemini uses `@zhivex-ai/gemini@0.10.4` and `gemini-3.6-flash` by default.
- Repeatable per-role model routes for explorer, implementer, tester, and reviewer subagents.
- A redacted, sequence-numbered JSON Lines stream contract through `--jsonl`.

### Changed

- Provider/model changes in the console create a new immutable run and compact/redact portable context rather than rebinding an old provider state.
- Durable harness fingerprints now include a non-secret hash of provider endpoint/region/workspace transport configuration.
- Provider diagnostics are registry-driven and continue to expose only declared variable names and booleans.
- The final JSON schema and resolved configuration schema remain at version `1` and `4` respectively.

### Migration from 0.6.x

- Prefer `zhx` for interactive use; existing `zhivex-harness` commands continue to work.
- Resolve or deny paused `0.6.x` approvals with the matching `0.6.x` artifact before upgrading. Harness-version binding intentionally rejects those resumes under `0.7.x`.
- Gemini is integrated but provisional until all credentialed harness live gates pass. Local tests, adapter evidence, and credential detection do not certify it.
- `--max-cost-usd` cannot be combined with per-role routes in `0.7.x`; pricing remains one operator-supplied pair and would misprice heterogeneous usage.

### Security

- Session metadata excludes prompts/messages/tool payloads and is isolated by canonical workspace and durable scope with bounded storage and optimistic SQLite transactions.
- JSONL projection omits tool inputs/outputs, approval arguments, provider payloads, images, raw errors, and full durable states.
- Provider/model handoff is blocked while an approval is pending and strips provider-specific tool payloads from future context.

## 0.6.1 - 2026-08-17

### Added

- A reproducible hostile-repository demonstration that exercises two durable approval boundaries, SQLite reopen, secret-free OCI execution, denied outbound network, separate host patch import, exactly-once journal evidence, ledger redaction, and stale-host rejection.
- A deterministic social-preview asset and a launch-oriented README path centered on governed repository change control.
- Structured GitHub issue forms for reproducible bugs and bounded feature requests.

### Changed

- Repositioned the package as a governed, provider-portable runtime for coding agents instead of a generic coding-agent harness.
- Expanded npm discovery metadata and documented the verified public `0.6.0` registry/provenance baseline.
- Updated support, security, roadmap, release, and certification documentation to reflect that `0.6.0` is published.

### Migration

- No runtime, CLI, configuration, persisted-state, or public-library contract changes are required from `0.6.0`.

### Security

- The demo uses a disposable fixture and a decoy secret; it never reads or prints operator credentials.
- The scripted proof does not weaken approvals: environment execution and host import remain separate interruptible operations.

## 0.6.0 - 2026-08-17

### Added

- An SDK-native enforced execution environment backed by Docker or Podman, with an adapter boundary for future remote workers.
- Secret-free ephemeral workspace snapshots, no container network, a read-only root filesystem, non-root execution, dropped capabilities, `no-new-privileges`, bounded CPU, memory, PIDs, time, output, workspace, file, and tmpfs usage. Commands run on a quota-backed tmpfs volume and publish successful results through a frozen, validated staging copy rather than a writable host bind mount.
- Approved argv-only `run_environment_command`, isolated `run_check`, read-only environment status and patch inspection, and a distinct approved patch-import tool for host mutations.
- Image/policy/workspace/run fingerprint binding, labeled container and volume ownership, cancellation cleanup, orphan cleanup, retained audit metadata, and installed-artifact plus real-runtime smoke coverage.
- An execution-environment guide and OCI diagnostics in `doctor`.

### Changed

- Resolved configuration uses schema version `4` and adds a discriminated `execution` policy. The default remains `none`, where generic shell is unavailable.
- Repository tools and subagents use the acquired snapshot while OCI execution is active. Host `git_diff` is omitted from the model tool set, and MCP is rejected before discovery rather than executing undeclared operations outside the no-network environment boundary.
- CLI runs persist their resolved non-secret configuration so a locator-only `resume --approve|--deny` restores the original OCI policy instead of falling back to `execution=none`.
- Environment patches compare, review, bind, import, and roll back file permission modes, including mode-only changes and newly created executable files.
- The Zhivex SDK dependency batch now resolves one `@zhivex-ai/core@1.6.0` runtime; OpenAI is updated to `0.9.5`.
- The release workflow is OIDC-only and runs the enforced OCI gate before packaging or live-provider certification.

### Migration

- Replace schema-version-pinned `schemaVersion: 3` configuration with `4`. Existing scoped SQLite data needs no database rewrite.
- Existing behavior remains available with `executionBackend: "none"` or `ZHIVEX_HARNESS_EXECUTION=none`; this does not expose shell-class tools.
- To enable OCI, preload the configured image and set `executionBackend: "oci"` (or `--execution oci`). Paused `0.5.x` runs cannot be silently rebound because the tool and execution fingerprints changed.
- Do not combine the enforced no-network OCI policy with network MCP in one run. Perform governed MCP discovery separately, or define a future policy/backend that can enforce the intended network boundary.

### Security

- Host credentials and arbitrary environment variables are not inherited by container processes; hard secret exclusions apply before snapshot creation.
- The harness never pulls images implicitly, never uses a shell to interpret model commands, and cleans only containers or volumes carrying its ownership label.
- Host changes require a content- and run-bound patch identifier plus a separate interrupt approval; stale host digests fail closed and deletions remain recoverable through quarantine.

## 0.5.0 - 2026-08-17

### Added

- Model capability inspection, fail-fast requirements, and deterministic candidate selection before MCP or agent execution.
- Schema-versioned declarative MCP configuration with explicit server/tool allowlists, permissions, environment-backed headers, bounded discovery, timeouts, and output-size ceilings.
- A bounded HTTPS/loopback-HTTP MCP JSON-RPC client plus injectable custom clients for library consumers.
- Named `explorer`, `implementer`, `tester`, and `reviewer` subagent profiles with independent durable budgets, leases, fingerprints, and inherited workspace/scope policy.
- Application-owned parallel read-only review groups through the `review` CLI command and `runHarnessReviewGroup` library API.
- Hierarchical child progress, approval identity, usage, cost/budget aggregation, and redacted run-tree inspection.
- An opt-in Meta/Qwen/OpenAI live orchestration matrix that verifies exact reviewer delegation, child persistence, SQLite reopen, hierarchy, and aggregate usage independently from the legacy reviewed-edit gate.
- Public npm metadata, security and support policies, exact-tarball inspection and installation gates, and a confirmation-gated GitHub Actions release workflow with npm provenance.

### Changed

- Resolved configuration uses schema version `3` and binds required capabilities, normalized MCP configuration, enabled profiles, and child policy into the harness fingerprint.
- Parent and child token guards enforce aggregate durable usage after each provider step, avoiding double reservation after a child consumes budget.
- The deterministic evaluation gate adds governed MCP and bounded-subagent scenarios.

### Migration

- Review schema-version-pinned configuration and replace `schemaVersion: 2` with `3`; existing scoped SQLite data needs no database rewrite.
- Named subagents are enabled by default. Pass `subagentProfiles: []` or set an empty `ZHIVEX_HARNESS_SUBAGENTS` value for a parent-only library run.
- Complete fingerprinted paused `0.4.x` runs with the `0.4.x` binary. They are not silently rebound to the new MCP, capability, approval, or child-policy contract.
- Keep MCP JSON configuration inside the canonical workspace and store only environment-variable names, never credential values.

### Security

- Network MCP calls always require durable interrupt approval, regardless of remote read-only annotations.
- MCP configuration rejects symlinks, workspace escapes, URL credentials, insecure non-loopback HTTP, unsafe headers, duplicate prefixes, and missing allowlists/permissions.
- MCP discovery and results fail closed on malformed schemas, prompt-injection directives, timeout, cancellation, and oversized output.
- Parallel review accepts only the read-only explorer/reviewer profiles; generic shell and `stdio` MCP remain unavailable until enforced execution environments.

## 0.4.0 - 2026-08-17 (private checkpoint)

### Added

- Scoped SQLite run and memory persistence as the default local operations store, including leases, compare-and-swap revisions, idempotency claims, and an exactly-once tool journal.
- `runs list`, `runs inspect`, `runs export`, `runs cancel`, and `runs cleanup` operator commands with schema-versioned JSON output.
- Step, wall-clock, tool-call, tool-error, input-token, output-token, total-token, and optional user-priced cost budgets.
- Deterministic bounded context compaction, production trace collection, redacted snapshots, traces, ledgers, and tool-journal inspection.
- A five-scenario golden evaluation gate covering analysis, edits and checks, denied approval, restart recovery, and provider portability.

### Changed

- Resolved configuration uses schema version `2`, includes an explicit durable scope, and defaults to the `sqlite` backend.
- Tool permissions, production safety policy, redaction, budget termination, durable memory, and harness/approval fingerprints are bound into every run.
- The installed-package smoke now proves SQLite restart recovery, exactly-once mutation journaling, redacted inspection, and the packaged golden baseline.

### Migration

- On first default local/workspace-scope open, legacy `0.3.x` file-backed runs are copied into the scoped backend and marked with `metadata.migratedFrom: "0.3-file-store"`; source files are retained for rollback. Custom scopes require intentional library migration.
- Use `--store file` or `ZHIVEX_HARNESS_STORE=file` only as a temporary compatibility path. New runs default to `<state-dir>/operations.sqlite`.
- Scope is part of durable identity. Use the same `--tenant`, `--user`, and `--namespace` values when listing, inspecting, exporting, cancelling, cleaning, or resuming a run.
- Resume rejects a mismatched workspace, provider/model, tool contract, approval policy, or harness fingerprint. Legacy paused runs receive the current binding only through the explicit resume path.
- Cost enforcement is enabled only when `--max-cost-usd` and input and/or output pricing are supplied; pricing is operator-provided and measured usage may cross the ceiling by one provider step.

### Security

- Operational exports omit raw messages, tool inputs/outputs, approval arguments, metadata, and full output text, and apply secret/email redaction.
- SQLite files are required to be regular non-symlink files and are created with owner-only permissions inside an owner-only state directory.
- Cleanup defaults to terminal states and requires an explicit cutoff; cancellation defaults to a cooperative request unless `--final` is supplied.

## 0.3.0 - 2026-08-16 (private checkpoint)

### Added

- Deterministic cursor pagination for file discovery and literal search, with SHA-256 content digests carried through inspection.
- Digest-bound multi-file proposals and conflict-safe patch application with mutation audit evidence.
- Approved file moves plus recoverable quarantine and restore operations; no permanent-delete model tool.
- Expanded read-only Git inspection for staged, unstaged, renamed, deleted, and untracked paths.
- A configurable explicit Bun package-script allowlist.
- Real Git repository fixtures covering inspect/edit/validate/diff, stale conflicts, rename, quarantine recovery, untracked files, failed checks, and final summaries.

### Changed

- Repository discovery respects Git and harness-specific ignore rules while keeping secret and state exclusions non-overridable.
- File replacement is published atomically, preserves existing modes, and rejects content changed after inspection.
- Repository-editing tools require reviewed content digests and emit before/after evidence.
- Upgraded `@zhivex-ai/meta` to `0.2.1`; Meta Chat streaming now preserves fragmented tool arguments and passed four consecutive proposal/approval/restart live gates.
- Live certification now exercises the contractual `propose_edits` then `apply_patch` sequence for every provider.
- The manual live-certification workflow defaults to the complete certified Meta, Qwen, and OpenAI matrix, with a documentation gate that rejects support-matrix drift.

### Migration

- Consume `nextCursor` until absent instead of treating a truncated list or search result as complete.
- Replace overwrite-oriented multi-file flows with `propose_edits` followed by approved `apply_patch` using the observed digest for every existing target and `null` for a target that must be new.
- Complete paused `0.2.x` approvals with the version that created them before upgrading; persisted approvals are not promised to migrate across tool-schema changes.
- Replace deletion workflows with `quarantine_file` and retain the returned identifier when later recovery may be required.

### Security

- Stale create/update/move/quarantine/restore requests fail before overwriting newer workspace content.
- Direct secret access, symlink escapes, special files, arbitrary host shell, Git writes, and permanent deletion remain unavailable.

## 0.2.0 - 2026-08-16

### Added

- Public package metadata and MIT licensing.
- A single runtime version source for the CLI and agent metadata.
- Versioned JSON output contracts and documented exit codes.
- A local `doctor` command that checks the runtime, workspace, Git, scripts, providers, and state directory without exposing credentials.
- Linux and macOS CI, installed-tarball smoke coverage, negative security regressions, and opt-in live-provider certification.

### Changed

- Package builds externalize declared dependencies instead of embedding the complete SDK in both entry points.
- New files are created with exclusive semantics to prevent concurrent non-overwrite calls from silently replacing one another.

### Migration

- `providers --json` now returns `{ schemaVersion: 1, kind: "providers", providers: [...] }` instead of a bare array.
- JSON run results now include `schemaVersion: 1` and `kind: "run-result"`.
- Invalid CLI usage exits with code `2`; a blocking `doctor` report exits with code `3`.
- State directories that target a workspace/filesystem root, protected workspace path, regular file, or symbolic link are rejected before the run store is created.

### Security

- Added regression coverage for protected state paths, special files, nested symlink escapes, concurrent creation, bounded output, timeout cleanup, and denied approvals.

## 0.1.0 - 2026-08-16

### Added

- Initial provider-portable coding harness MVP for Meta, Qwen, and OpenAI.
