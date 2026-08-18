# Zhivex Harness Roadmap

- Status: active
- Baseline date: 2026-08-17

This roadmap takes the harness from its `0.1.0` MVP to a stable CLI and library contract. The `0.2.0` source baseline is tagged locally, `0.3.0` and `0.4.0` are private checkpoints, and `0.5.0` plus `0.6.0` are published on npm. `0.6.1` is the local positioning and hostile-repository proof patch; publishing it remains a separate explicit operation. Releases are ordered by dependency and safety risk, not by calendar date. A version ships only when its exit criteria are satisfied.

## Planning principles

- Make the harness distributable and observable before expanding its side-effect surface.
- Keep provider portability in the harness and provider-specific behavior behind capability checks.
- Reuse Stable `@zhivex-ai/agents` runtime contracts for safety, durability, tracing, evaluation, subagents, and execution environments.
- Keep generic shell execution behind an enforced container or remote-worker boundary.
- Treat local, installed-package, live-provider, and published-artifact evidence as separate gates.
- Keep the CLI Bun-first. JavaScript and TypeScript project checks continue to run through Bun.

## Historical baseline: 0.2.0

The tagged source baseline provides:

- one-shot and interactive execution;
- Meta, Qwen, and OpenAI model adapters;
- bounded repository listing, literal search, file reads, file writes, and exact replacement;
- approved `test`, `typecheck`, `lint`, and `build` scripts;
- read-only Git status and unstaged diff;
- durable file-backed runs and approval resume;
- path traversal, external symlink, secret-file, size, output, step, and timeout guards.

The deterministic baseline, TypeScript typechecking, dependency-externalized build, package inspection, and installed-tarball smoke are implemented. The package has public MIT metadata, CI, changelog, CLI/config schema versioning, `doctor`, and negative security regressions. All three provider credentials are configured locally without being exposed by diagnostics. Live certification is date-bound and recorded separately; each later publication and provenance verification remains an external release operation.

The `0.6.0` dependency batch pins and overrides `@zhivex-ai/core@1.6.0`, retaining `@zhivex-ai/agents@1.2.0`, Meta `0.2.1`, Qwen `0.10.1`, and updating OpenAI to `0.9.5`. The Bun lockfile resolves one core runtime rather than duplicating SDK contract identities.

## Release sequence

| Version | Theme | Primary outcome | Status | Relative size |
| --- | --- | --- | --- | --- |
| `0.2.0` | Releasable foundation | A versioned, installable, diagnosable CLI | Local release baseline | M |
| `0.3.0` | Trusted repository editing | Reviewable and recoverable multi-file changes | Private checkpoint | M |
| `0.4.0` | Durable operations | Inspectable, budgeted, cancellable, evaluable runs | Private checkpoint | L |
| `0.5.0` | Extensibility and orchestration | Governed MCP and bounded multi-agent work | Published on npm | L |
| `0.6.0` | Enforced execution | Shell and checks inside a real isolation boundary | Published on npm | XL |
| `0.6.1` | Positioning and proof | Reproducible hostile-repository control evidence | Implemented locally | S |
| `1.0.0` | Stable contract | Supported compatibility and release guarantees | Planned | L |

Relative size is for sequencing only; dates require a capacity decision.

## 0.2.0 — Releasable foundation (release candidate)

Goal: make the existing narrow harness safe to install, automate, diagnose, and release without broadening its write or command surface.

Scope:

- Add license, repository, issue tracker, `publishConfig`, changelog, release notes, and an explicit public/private publication decision.
- Replace duplicated version literals in `package.json`, agent metadata, and CLI output with one generated or imported version source.
- Define versioned config and JSON output schemas, documented exit codes, and a compatibility policy for `0.x`.
- Add `doctor` for Bun version, workspace, Git, scripts, provider capability, credential presence, state-directory permissions, and endpoint diagnostics without printing secrets.
- Add CI for typecheck, tests, build, CLI smoke, and package-content inspection on Linux and macOS.
- Pack the tarball, install it into a clean fixture, and exercise `--help`, `--version`, `providers`, one mock run, and approval resume through the installed binary.
- Add negative security tests for state paths, special files, nested symlinks, race-sensitive writes, output truncation, timeout cleanup, and denied approvals.
- Add an opt-in live gate for Meta, Qwen, and OpenAI: forced local tool call, approval pause, process restart, resume, and exactly-once side effect.

Exit criteria:

- `bun run check` and the installed-tarball smoke pass from a clean checkout.
- CI is required on the default branch and produces no tracked build artifacts.
- Config, JSON output, exit codes, and security boundaries are documented.
- Every advertised provider passes the live gate, or is explicitly marked uncertified and excluded from the supported matrix.
- Publishing remains a separate, intentional operation after artifact inspection.

## 0.3.0 — Trusted repository editing

Goal: let the agent make realistic multi-file changes while every mutation remains bounded, reviewable, conflict-safe, and recoverable.

Status: validated private candidate. It is not configured for registry publication. Contract and migration details live in [docs/REPOSITORY_EDITING.md](./docs/REPOSITORY_EDITING.md).

Scope:

- Respect hierarchical `.gitignore` files plus `.zhivex-harnessignore` while preserving hard secret exclusions.
- Add paginated file discovery and search with deterministic ordering and explicit truncation cursors.
- Add a patch proposal/apply flow with expected-content digests, atomic writes, file-mode preservation, and stale-workspace rejection.
- Extend Git inspection to staged, unstaged, renamed, deleted, and untracked files without exposing Git writes.
- Add approved move and recoverable delete operations. Deletions go to a harness-owned quarantine with an explicit restore path; permanent deletion is not a model tool.
- Make the check allowlist configurable but explicit. Do not add arbitrary in-process shell execution.
- Add fixture-repository end-to-end tests covering multi-file edits, conflicts, restore, formatting, failed checks, and final diff review.

Exit criteria:

- No write can silently overwrite content changed after the model inspected it.
- Every mutation produces a before/after audit record and appears in the final diff summary.
- Delete/restore and interrupted atomic-write tests pass on supported platforms.
- Real repository fixtures prove a complete inspect, edit, validate, and summarize loop.

Required release evidence:

- focused workspace and fixture-repository tests pass on Linux and macOS;
- pagination is deterministic and cursors reject incompatible reuse;
- a stale precondition leaves every proposed target unchanged;
- move, quarantine, restore, failed check, and final Git/audit summaries are exercised from a real Git repository;
- migration and safety boundaries are documented without claiming host isolation or permanent deletion;
- `0.3.0` remains private until an explicit publication decision is made.

Validation snapshot (2026-08-16):

- the trusted-editing implementation is merged into `main`;
- deterministic, installed-package, and package-inspection CI gates pass on Linux and macOS;
- the date-bound Meta, Qwen, and OpenAI proposal/approval/restart matrix is recorded in [docs/LIVE_CERTIFICATION.md](./docs/LIVE_CERTIFICATION.md);
- publication, registry integrity, and provenance have not been attempted or claimed.

## 0.4.0 — Durable operations and evaluation

Goal: make runs supportable over time instead of only executable from one terminal.

Status: validated private candidate. Operations and migration details live in [docs/DURABLE_OPERATIONS.md](./docs/DURABLE_OPERATIONS.md).

Scope:

- Adopt the Stable production safety policy, explicit permission metadata, budget guards, and redacted telemetry from `@zhivex-ai/agents`.
- Add run list, inspect, cancel, resume, retention, and cleanup commands with machine-readable output.
- Add idempotency keys, scope, durable cancellation, tool-journal evidence, and SQLite as the default concurrent local store; retain file-store migration support.
- Add token, step, wall-clock, tool-call, and optional cost budgets with clear termination reasons.
- Add bounded memory and context compaction with durable compaction records.
- Export redacted snapshots, traces, tool audit records, and run ledgers.
- Add deterministic evaluation fixtures and golden traces for analysis-only, edit-and-test, denied-approval, failure-recovery, and provider-switch scenarios.
- Add an evaluation regression gate for success, safety, tool use, latency, and cost budgets.

Exit criteria:

- Restart, duplicate request, concurrent resume, cancellation, expired work, and retention tests pass without repeated side effects.
- State migration from `0.3.x` is tested and documented.
- Golden fixtures are deterministic and the regression gate runs in CI.
- Exported operational artifacts are redacted by default and schema-versioned.

Validation snapshot (2026-08-17):

- deterministic tests, the five-case golden evaluation gate, typecheck, docs, build, and installed-tarball smoke pass;
- migration, idempotency, concurrent ownership, expired-lease recovery, cancellation, retention, Qwen token enforcement, and export redaction have regression coverage;
- Meta, Qwen, and OpenAI passed the scoped-SQLite approval/restart/exactly-once live matrix;
- registry publication, provenance, tag creation, commit, and push have not been attempted or claimed.

## 0.5.0 — Extensibility and orchestration

Goal: support larger tasks through governed external tools and bounded delegation without weakening workspace policy.

Status: published on npm. Configuration, migration, MCP, and orchestration contracts live in [docs/EXTENSIBILITY.md](./docs/EXTENSIBILITY.md). Its Trusted Publisher/OIDC release path is the baseline for later immutable versions.

Scope:

- Add capability-based provider/model selection and reject unsupported requested capabilities before a run begins.
- Add declarative MCP server configuration with server/tool allowlists, permission metadata, timeouts, output limits, and approval policies.
- Start with read-only MCP tools; network or write-like MCP tools always require explicit approval and durable audit evidence.
- Add named subagent profiles such as explorer, implementer, tester, and reviewer using Stable SDK subagent and handoff contracts.
- Give child runs independent step/token/time budgets while inheriting workspace, secret, approval, and execution-environment policies.
- Add deterministic application-owned parallel review through agent groups; reserve model-directed delegation for true subagent cases.
- Surface child progress, promoted approvals, hierarchy, and cost in streaming and JSON output.

Exit criteria:

- An unconfigured or capability-incompatible model cannot enter an MCP or subagent flow.
- Child approval pause/resume, cancellation propagation, exactly-once recovery, hierarchy traces, and aggregate budgets pass end-to-end tests.
- MCP prompt injection and oversized/malformed result tests fail safely.
- Provider-specific limitations are recorded in a live support matrix.

Validation snapshot (2026-08-17 UTC):

- deterministic tests, the seven-case golden evaluation gate, typecheck, docs, build, dependency audit, dry-run package inspection, and installed-tarball smoke pass;
- malformed MCP, HTTP handshake/session, injection/output bounds, approval/restart, child mutation exactly-once, cancellation, scoped hierarchy, aggregate budget, and parallel review have regression coverage;
- controlled Streamable HTTP MCP interoperability passed over a real loopback server with session negotiation, JSON and SSE responses, tool discovery, bounded execution, and forced network approval at `2026-08-17T16:48:09.043Z`;
- independent interoperability with `@modelcontextprotocol/server@2.0.0` passed over loopback in its documented `2025-06-18` legacy-stateless compatibility mode at `2026-08-17T16:48:09.141Z`;
- Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, and OpenAI `gpt-5.4` passed the separate model-directed reviewer delegation, child persistence, SQLite reopen, hierarchy, and aggregate-usage matrix at `2026-08-17T02:21:45.553Z`;
- the exact `0.5.0` artifact was published and its post-publication registry/provenance verification completed; that evidence does not pre-certify `0.6.0`.

## 0.6.0 — Enforced execution environments

Goal: introduce shell-class capabilities only when the declared filesystem, process, network, and resource controls are real.

Status: 0.6.0 is published on npm. Deterministic, exact installed-artifact, real-OCI, MCP-interoperability, all-provider live, registry-integrity, and SLSA provenance gates passed.

Scope:

- Implement the SDK execution-environment contract for a local OCI/container backend, with an adapter boundary for future remote workers.
- Bind run resume to the environment manifest, workspace identity, image digest, policy version, and harness fingerprint.
- Execute approved shell and package checks only inside the acquired environment; keep in-process generic shell unavailable.
- Default to no network, bounded CPU/memory/process/time/output, a non-root user, and an ephemeral workspace snapshot.
- Export a patch/artifact from the snapshot and require a separate approval before applying it to the host workspace.
- Add image lifecycle, orphan cleanup, cancellation, crash recovery, and auditable environment acquisition/release.
- Document Docker/OCI prerequisites and the weaker fallback behavior when enforced execution is unavailable.

Exit criteria:

- Escape, network-denial, resource-exhaustion, fork-bomb, secret-mount, changed-fingerprint resume, cancellation, and orphan-cleanup tests pass.
- Host workspace changes occur only through the approved patch import path.
- Installed-artifact and live-provider tests exercise the enforced backend.
- The product is described as a local enforced runner, not a managed sandbox service.

Implementation snapshot (2026-08-17):

- the SDK execution-environment contract is implemented with a Docker/Podman adapter, immutable image identity, per-tool-call isolation, manifest authorization, and run fingerprint binding;
- the enforced policy denies network and undeclared tools, uses a non-root identity, read-only root, dropped capabilities, no-new-privileges, and bounded memory, CPU, PIDs, time, output, snapshot, imported-file, and tmpfs resources;
- repository tools and subagents share an ephemeral secret-free snapshot; package checks and argv-only commands run inside OCI, while network MCP fails closed under the no-network policy;
- content- and run-bound patch inspection plus a separate durable import approval are the only environment-to-host mutation path; deletes remain recoverable through quarantine;
- lifecycle metadata, cancellation removal, run-labeled container and quota-volume cleanup, terminal artifact retention cleanup, deterministic regression tests, installed-package smoke, and required Linux OCI workflow gates are implemented;
- the real Docker smoke passed again at `2026-08-17T16:48Z` against Docker `29.7.2` and the pinned Bun image digest, covering network/root/secret boundaries, total-workspace and per-file capacity, read-only dependency reuse, memory/PID/output limits, cancellation, transactional snapshot synchronization, patch import, and zero labeled orphans;
- the installed-package smoke passed with the public execution-environment API and snapshot/import flow;
- the exact local `0.6.0` tarball passed the 31-file allowlist, SHA-512 generation, isolated consumer install, binary, public API, durability, and execution-environment smoke;
- Meta, Qwen, and OpenAI passed the final model-directed OCI command, patch review, separate import approval, journal, host-content, and binding matrix together at `2026-08-17T16:49:12.975Z`;
- the base approval/restart matrix and bounded reviewer-delegation/persistence/hierarchy matrix passed again at `2026-08-17T16:22:34.885Z` and `2026-08-17T16:24:14.381Z` respectively;
- `@zhivex-ai/core@1.6.0` resolves as one runtime through the aligned dependency batch;
- annotated tag `v0.6.0`, push, protected OIDC publication, exact registry integrity, the `latest` distribution tag, and SLSA workflow provenance agree with source commit `fd420f7560b2`.

### 0.6.1 positioning patch

`0.6.1` keeps the `0.6.0` runtime, CLI, configuration, state, and library contracts unchanged. It adds a launch-oriented package description, expanded discovery metadata, a deterministic social card, structured issue forms, and a hostile-repository demo that exposes the existing safety chain as one reproducible product proof.

Its deterministic demo test uses an injected OCI adapter. The public `bun run demo:hostile` command uses a real preloaded Docker/Podman image and proves secret exclusion, network denial, two durable approvals across persistence reopen, host immutability before import, exactly-once journal evidence, redacted inspection, and stale-host rejection. Publication, a `v0.6.1` tag, registry integrity, and provenance are not claimed until the normal protected release workflow completes.

## 1.0.0 — Stable CLI and library contract

Goal: freeze a supportable public contract after the pre-1.0 safety and operational surfaces have been exercised in real repositories.

Scope:

- Stabilize CLI commands, config schema, JSON/event schemas, library exports, state migrations, and error taxonomy.
- Publish a support matrix for Bun, operating systems, Git, container backend, providers, models, MCP modes, and store backends.
- Guarantee tested migration from the final two `0.x` state/config formats or provide an explicit export/import tool.
- Complete threat model, security review, dependency audit, provenance, integrity, and rollback documentation.
- Run a representative repository evaluation matrix across every supported provider and publish date-bound evidence.
- Add full installation, operations, policy, MCP, isolation, troubleshooting, migration, and release documentation.
- Require release candidates before `latest`; no direct `0.6.x` to untested GA promotion.

Exit criteria:

- Two release candidates complete without a contract-breaking defect.
- Clean-machine install, installed-tarball, migration, evaluation, live-provider, and enforced-environment gates pass.
- Versioned artifacts, checksums/provenance, tag, changelog, and published package metadata agree with the source commit.
- No open critical/high security finding and no undocumented unsupported provider path.

## Cross-release definition of done

Every version must include:

- unit, integration, failure-path, and security regression tests proportional to the changed surface;
- typecheck, build, source CLI smoke, packed-artifact inspection, and installed CLI smoke;
- documentation and changelog entries for behavior, config, state, and compatibility changes;
- a migration note for every persisted-state or user-facing schema change;
- provider live certification when provider behavior, tools, approvals, or streaming changes;
- explicit separation of local proof, installed-artifact proof, live proof, and publication proof;
- a clean worktree and reproducible Bun lockfile before the release commit.

## Explicit non-goals through 1.0

- A desktop IDE or hosted operator UI.
- A Zhivex-managed remote sandbox service or hosted control plane.
- Automatic Git commit, push, pull request creation, deployment, or publication.
- Unapproved permanent deletion or arbitrary host shell execution.
- Claiming provider parity where upstream capabilities differ.

These can become separate post-1.0 tracks after the CLI/runtime contract and security model are stable.

## Immediate next actions

1. Review the `0.6.1` positioning/demo diff and run the full deterministic, real-OCI, and installed-artifact gates.
2. Record the hostile-repository demo and publish the exact evidence output with the release notes.
3. Merge/push the reviewed release commit, create the annotated `v0.6.1` tag, then dispatch the protected OIDC workflow and verify registry integrity/provenance against the exact tagged artifact.
4. Continue governed MCP/delegation dogfood on representative repositories beyond the controlled and official-SDK interoperability gates.
