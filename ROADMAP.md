# Zhivex Harness Roadmap

- Status: active
- Baseline date: 2026-08-21

This roadmap takes the harness from its `0.1.0` MVP to a stable CLI and library contract. The `0.2.0` source baseline is tagged locally, `0.3.0` and `0.4.0` are private checkpoints, and `0.5.0` through `0.11.1` are published on npm. Version `0.11.1` delivers file and release hardening without a `0.11.x` contract change; registry publication, supply-chain provenance, and provider certification remain separate evidence boundaries. Releases are ordered by dependency and safety risk, not by calendar date. A version ships only when its exit criteria are satisfied.

## Planning principles

- Make the harness distributable and observable before expanding its side-effect surface.
- Keep provider portability in the harness and provider-specific behavior behind capability checks.
- Reuse Stable `@zhivex-ai/agents` runtime contracts for safety, durability, tracing, evaluation, subagents, and execution environments.
- Keep generic shell execution behind an enforced container or remote-worker boundary.
- Treat local, installed-package, live-provider, and published-artifact evidence as separate gates.
- Keep the public CLI Node-first while retaining Bun for contributor tooling and explicitly Bun-managed repositories. JavaScript and TypeScript checks run through the target repository's pinned or unambiguously detected package manager.

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
| `0.6.1` | Positioning and proof | Reproducible hostile-repository control evidence | Published on npm | S |
| `0.7.0` | Multi-provider agent console | Durable sessions, extensible providers, safe role routing, and automation events | Published on npm | L |
| `0.8.0` | SDK refresh and GPT-5.6 | One Core runtime, current adapters, and a GPT-5.6-first OpenAI path | Published on npm | M |
| `0.9.0` | Fast governed change admission | Lower repository/OCI overhead plus portable offline evidence bound to exact patch bytes | Published on npm | L |
| `0.10.0` | Node-first portability | Node CLI/library, portable SQLite/processes, manager-aware checks, and Node OCI | Published on npm | L |
| `0.11.0` | Daily-driver foundations | Richer terminal operation, governed context/skills/hooks, and opt-in OCI shell | Published on npm | L |
| `0.11.1` | Security and release hardening | Bounded reads, recoverable cleanup, and fail-closed release evidence | Published on npm | S |
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

Validation summary:

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

Validation summary:

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

Validation summary:

- deterministic tests, the seven-case golden evaluation gate, typecheck, docs, build, dependency audit, dry-run package inspection, and installed-tarball smoke pass;
- malformed MCP, HTTP handshake/session, injection/output bounds, approval/restart, child mutation exactly-once, cancellation, scoped hierarchy, aggregate budget, and parallel review have regression coverage;
- controlled and official-SDK Streamable HTTP MCP interoperability passed over real loopback transports with session negotiation, bounded execution, and forced network approval;
- the certified provider cohort passed the separate model-directed reviewer delegation, child persistence, SQLite reopen, hierarchy, and aggregate-usage matrix;
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

Implementation summary:

- the SDK execution-environment contract is implemented with a Docker/Podman adapter, immutable image identity, paused per-run isolation, transactional command publication, manifest authorization, and run fingerprint binding;
- the enforced policy denies network and undeclared tools, uses a non-root identity, read-only root, dropped capabilities, no-new-privileges, and bounded memory, CPU, PIDs, time, output, snapshot, imported-file, and tmpfs resources;
- repository tools and subagents share an ephemeral secret-free snapshot; package checks and argv-only commands run inside OCI, while network MCP fails closed under the no-network policy;
- content- and run-bound patch inspection plus a separate durable import approval are the only environment-to-host mutation path; deletes remain recoverable through quarantine;
- lifecycle metadata, cancellation removal, run-labeled container and quota-volume cleanup, terminal artifact retention cleanup, deterministic regression tests, installed-package smoke, and required Linux OCI workflow gates are implemented;
- the real Docker smoke passed against the pinned image identity, covering network/root/secret boundaries, capacity and resource limits, cancellation, transactional snapshot synchronization, patch import, and zero labeled orphans;
- the installed-package smoke passed with the public execution-environment API and snapshot/import flow;
- the exact local `0.6.0` tarball passed the 31-file allowlist, SHA-512 generation, isolated consumer install, binary, public API, durability, and execution-environment smoke;
- the certified provider cohort passed the model-directed OCI command, patch review, separate import approval, journal, host-content, and binding matrix;
- the base approval/restart and bounded reviewer-delegation/persistence/hierarchy matrices passed against the release artifact;
- `@zhivex-ai/core@1.6.0` resolves as one runtime through the aligned dependency batch;
- the annotated tag, protected publication, registry integrity, distribution tag, and SLSA workflow provenance agree with the release source.

### 0.6.1 positioning patch

`0.6.1` keeps the `0.6.0` runtime, CLI, configuration, state, and library contracts unchanged. It adds a launch-oriented package description, expanded discovery metadata, a deterministic social card, structured issue forms, and a hostile-repository demo that exposes the existing safety chain as one reproducible product proof.

Its deterministic demo test uses an injected OCI adapter. The public `bun run demo:hostile` command uses a real preloaded Docker/Podman image and proves secret exclusion, network denial, two durable approvals across persistence reopen, host immutability before import, exactly-once journal evidence, redacted inspection, and stale-host rejection. The annotated `v0.6.1` tag, npm artifact, registry integrity, and provenance were subsequently verified through the protected workflow.

## 0.7.0 — Multi-provider agent console

Status: published on npm. Gemini and mixed-provider routing remain provisional until their required live validation is recorded in a later release artifact.

Goal: turn the harness from a collection of one-shot commands into an ergonomic local agent console while preserving immutable runs and provider portability.

Scope:

- Publish the short `zhx` command while retaining `zhivex-harness` for scripts.
- Add a durable SQLite session index that links immutable runs without duplicating prompts, messages, tool payloads, or provider data.
- Add a public validated provider registry and native Gemini integration without aliasing an OpenAI-compatible transport.
- Route explorer, implementer, tester, and reviewer roles to explicit provider/model pairs.
- Add safe console commands for provider/model/routes, status, diff, review, session resume/new/rename, and deterministic redacted compaction.
- Add sequence-numbered redacted JSONL events for automation.
- Bind non-secret provider transport configuration into durable resume fingerprints.

Exit criteria:

- Registry, Gemini factory/diagnostics, sessions/reopen/fork/archive, routing, approval restart, JSONL redaction, and both CLI aliases pass deterministic and installed-package tests.
- Cross-provider handoff always starts a new run, is blocked by pending approvals, and carries no raw tool/provider payload.
- Existing `run`, `review`, `resume`, `runs`, final JSON, configuration schema, and `zhivex-harness` commands remain compatible.
- Gemini passes the base edit/restart, delegation, and OCI matrices before moving from provisional to certified.
- The exact tarball, release tag, registry integrity, and provenance are verified separately; source readiness is not publication.

Deferred after `0.7.0`:

- Per-provider/per-role cost pricing and evidence-backed routing presets.
- Additional hosted and local providers, added one by one through the same registry and certification contract.
- Remote workers or microVM backends; the current console stays local and moves to a Node-first runtime in `0.10.0`.

## 0.8.0 — SDK refresh and GPT-5.6-first OpenAI

Status: published on npm with registry provenance. Provider evidence remains date- and model-bound.

Goal: adopt the coordinated SDK release batch without duplicating Core contracts, make the current GPT-5.6 family the primary OpenAI experience, and keep approval pauses reliable across provider behavior changes.

Scope:

- Pin Core `1.7.0`, Agents `1.2.0`, Meta `0.2.2`, Qwen `0.10.2`, OpenAI `0.9.6`, and Gemini `0.10.5`, with one overridden Core runtime.
- Default OpenAI to `gpt-5.6-luna`, with explicit Terra and Sol selection.
- Tell models to emit the reviewed approval-gated tool call so the runtime, rather than prose, owns the pause and restart boundary.
- Document migration from the `0.7.x` OpenAI default and durable version binding.

Exit criteria:

- Frozen install, dependency deduplication, documentation, typecheck, tests, evaluation, build, package inspection, and installed-tarball smoke pass.
- Luna, Terra, and Sol pass the base proposal/approval/restart/exactly-once live gate with date-bound evidence.
- The exact release artifact, annotated tag, registry integrity, and provenance are verified independently before claiming publication.

## 0.9.0 — fast governed change admission

Status: published on npm with its release tag, registry integrity, and provenance verified separately from source validation.

Goal: reduce the cost of inspecting large repositories and materialize the harness's change-control evidence as a portable, agent-agnostic admission contract.

Scope:

- Reuse a freshness-checked, topology-only workspace index across pages while keeping file contents and digests on the stable anti-race read path.
- Add bounded batch reads and multi-query search without enabling unsafe global tool parallelism.
- Reduce OCI snapshot memory and duplicate patch-comparison reads without introducing a long-lived container or weakening transactional publication.
- Expose reproducible workspace benchmarks plus workspace-index and OCI I/O diagnostics.
- Add deterministic `ChangeEnvelope v1` creation and offline verification bound to exact patch bytes, base identity, policy/environment fingerprints, redacted check evidence, expiry, approval references, and external-attestation references.
- Keep authenticity explicit: built-in verification checks integrity, expiration, and preconditions; external signatures and attestations require their native verifier.

Exit criteria:

- Workspace index invalidation, external-change freshness, cursor staleness, batch bounds, duplicate reads, and multi-query single-pass behavior have deterministic regression coverage.
- The 5,000-file benchmark reports one index build and materially improves complete pagination against the pre-`0.9` baseline without setting a flaky CI wall-time threshold.
- OCI deterministic tests prove independent base/workspace copies, bounded inventory pages, changed-file-only patch reads, and unchanged import/stale-host guarantees; a real daemon gate remains mandatory for release.
- Change-envelope tests cover canonical determinism, exact patch tampering, base/policy/evidence changes, expiry, strict redaction schemas, and explicit authenticity limits.
- Documentation, typecheck, full tests, evaluation, build, package inspection, and installed-tarball smoke pass from a clean release commit before any tag or publication.

## 0.10.0 — Node-first runtime portability

Status: published on npm with the `v0.10.0` tag. Later source work is not covered by that release's artifact or provenance evidence.

Goal: remove Bun as an installation prerequisite without weakening governed execution or forcing target repositories to adopt one package manager.

Scope:

- Publish `zhx`, `zhivex-harness`, and the library as Node-targeted ESM for Node.js `>=22.13.0`; retain Bun contributor workflows and compatibility imports.
- Use `node:sqlite` and `node:child_process` behind bounded adapters while preserving the existing SQLite file, scopes, approvals, sessions, leases, and exactly-once journals.
- Detect npm, pnpm, Yarn, or Bun from `packageManager` or one unambiguous lockfile; default to npm and reject symbolic-link/ambiguous lockfiles plus unreviewed lifecycle hooks.
- Run the enforced controller in Node 24 with `node,npm` defaults, a new execution-policy fingerprint, and explicit custom-image/allowlist requirements for other managers.
- Certify direct Node 22/24 execution, installed artifact behavior, SQLite reopen, both CLI aliases, public imports, and secondary Bun compatibility.

Exit criteria:

- The built and installed package imports and executes under supported Node versions without a `bun:` module or `Bun` global.
- Bun-created SQLite state reopens under Node and preserves durable approval/exactly-once behavior; Bun can still import the Node-targeted artifact.
- Host and OCI checks cover npm by default plus explicit Bun, ambiguous lockfiles, stale script text, hidden lifecycle hooks, timeouts, cancellation, and bounded output.
- Linux real-OCI validation passes on the preloaded Node 24 image with unchanged network/rootfs/resource/patch-import guarantees.
- Documentation, typecheck, full tests, evaluation, build, package inspection, installed-artifact smoke, release checks, live matrix, tag, registry integrity, and provenance are closed independently.

## 0.11.0 — daily-driver foundations

Status: published on npm as `latest` with annotated tag `v0.11.0`, exact registry integrity, and SLSA provenance. Release-bound remote provider certification remains pending and is not implied by publication.

Goal: make the governed runtime practical for daily interactive work without giving repository content or shell syntax authority over host policy.

Scope:

- Render redacted step/tool activity and safe approval cards, and resolve recovered approvals from the durable chat console with `/pending`, `/approve`, and `/deny`.
- Load bounded root/project context and rules, expose a metadata-only skill catalog, and load skill instructions progressively instead of injecting every skill into the initial prompt.
- Add trusted application lifecycle hooks identified by version in the harness binding; repository manifests never introduce executable host hooks.
- Expose full shell syntax only behind explicit `--execution oci --oci-shell ask`, with exact-script approval, denied container network, resource limits, and separate host patch-import approval.
- Keep semantic search, IDE clients, remote workers, executable project hooks, and network-enabled sandbox profiles as later independently governed tracks.

Exit criteria:

- TTY, no-color, approval-resume, context traversal/symlink, skill disclosure, hook redaction/failure, and OCI shell policy regressions pass.
- The full deterministic, package, and real-OCI gates pass from a clean commit before any release number, tag, or publication is claimed.

## 0.11.1 — security and release hardening

Status: published on npm as `latest` with annotated tag `v0.11.1`, exact registry integrity, SLSA provenance, and successful release-bound Meta/Qwen/OpenAI certification.

Goal: ship the reviewed security and release hardening accumulated after `0.11.0` without changing configuration, durable state, or execution-policy contracts.

Scope:

- bind sensitive reads and release archive staging to bounded, no-follow regular-file snapshots;
- recover cleanup directories left by interrupted OCI artifact deletion;
- preserve transient provider status through the live-smoke retry boundary;
- classify tool failures with complete tokens in one linear scan; and
- keep publication fail-closed on the exact tag, tarball, live-provider matrix, registry integrity, and provenance.

Exit criteria:

- focused security regressions, the complete deterministic gate, installed-package smoke, and real OCI pass;
- the exact annotated tag passes base, orchestration, routing, and model-directed live execution; and
- npm `latest`, tarball SHA-512, SLSA provenance, tag, and source commit agree.

## 1.0.0 — Stable CLI and library contract

Goal: freeze a supportable public contract after the pre-1.0 safety and operational surfaces have been exercised in real repositories.

Status: RC.1 through RC.6 passed exact-artifact validation but failed protected certification, so every publication was skipped and npm remained unchanged. RC.6 passed release-bound live certification and Meta's complete representative matrix, then failed closed at Qwen with 12/14 safe resolutions in both the original run and one retry. RC.7 retained the Core, Agents, and OpenAI corrections, restored Qwen to the last adapter certified by this matrix, passed exact-artifact, live-provider, and all three 14-case representative gates, and was published to npm `next` with verified SHA-512 integrity and SLSA provenance. RC.8 is the pending coordinated Core `1.11.0`, Qwen `0.11.1`, and Gemini `0.11.0` refresh; it does not count toward GA until its exact artifact passes every protected gate. Public API/CLI/schema baselines, config `4 → 5` migration, historical tarball fixtures, support/security/rollback policy, RC channel enforcement, representative-evaluation generation, and evidence requirements remain machine-checked. GA remains blocked on the two open evidence classes in [`docs/ga-readiness.json`](./docs/ga-readiness.json): a later independent passing release candidate and the final-candidate security review.

Scope:

- Stabilize CLI commands, config schema, JSON/event schemas, library exports, state migrations, and error taxonomy.
- Publish a support matrix for Node, secondary Bun compatibility, operating systems, Git, container backend, providers, models, MCP modes, and store backends.
- Guarantee tested migration from the final two `0.x` state/config formats or provide an explicit export/import tool.
- Complete threat model, security review, dependency audit, provenance, integrity, and rollback documentation.
- Run a representative repository evaluation matrix across every supported provider and publish date-bound evidence.
- Add full installation, operations, policy, MCP, isolation, troubleshooting, migration, and release documentation.
- Require release candidates before `latest`; no direct pre-1.0 source checkpoint to untested GA promotion.

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

1. Preserve RC.7's published exact-artifact, live-provider, representative-matrix, registry-integrity, and SLSA provenance evidence.
2. Complete deterministic, installed-artifact, and real-OCI validation for the coordinated RC.8 dependency refresh.
3. After merge and an annotated tag, run RC.8 through live-provider, mixed-routing, model-directed OCI, and the complete representative matrix before any publication decision.
4. Complete the named security review against the final passing candidate and close every critical/high finding.
5. Promote a separately tagged and verified `1.0.0` artifact to `latest` only after the release-mode readiness gate passes with two passing candidates.
