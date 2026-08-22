# Zhivex Harness

**Governed execution for coding agents.**

[![npm](https://img.shields.io/npm/v/%40zhivex-ai%2Fharness?logo=npm)](https://www.npmjs.com/package/@zhivex-ai/harness)
[![CI](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

![Zhivex Harness: Let agents work. Control every change.](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/assets/social-preview.png)

Zhivex Harness runs coding agents against real repositories with conflict-safe edits, durable approvals, isolated execution, and redacted operational evidence. It is a Node-first local CLI and TypeScript library portable across Meta, Qwen, OpenAI, and provisional Gemini support, built on the Stable `@zhivex-ai/agents` runtime. Bun remains supported as development tooling and as an explicitly selected repository package manager.

The model provides capability. The harness controls what it may inspect, execute, change, resume, and prove. Every provider uses the same bounded tool and approval contract.

Version `0.11.0` is the current source release candidate. The latest public npm release remains the tagged Node-first `0.10.0` artifact until the reviewed release workflow publishes and verifies `0.11.0`; local validation alone does not publish or certify registry provenance. See [ROADMAP.md](./ROADMAP.md), [CHANGELOG.md](./CHANGELOG.md), the [change-envelope guide](./docs/CHANGE_ENVELOPES.md), the [CLI contract](./docs/CLI.md), the [context-engineering guide](./docs/CONTEXT_ENGINEERING.md), the [extensibility guide](./docs/EXTENSIBILITY.md), and the [durable-operations guide](./docs/DURABLE_OPERATIONS.md).

## Why Zhivex Harness

Provider choice, MCP, subagents, and containers are useful building blocks. Zhivex Harness focuses on the change-control path that connects them:

1. copy an eligible, secret-free repository snapshot into an enforced OCI environment;
2. execute only approved, allowlisted argv commands without host shell interpolation or container network;
3. inspect a content- and run-bound patch while the host workspace remains unchanged;
4. require a separate durable approval before importing that exact patch; and
5. reject the import if either the reviewed patch or the host preconditions changed.

Approvals, leases, idempotency claims, execution bindings, and exactly-once tool journals survive process restarts. Host deletions remain recoverable through quarantine, and operator exports are redacted by default.

## Prove the boundary in five minutes

The hostile-repository demo creates a disposable fixture containing malicious instructions and a decoy `.env`, then exercises the real OCI, approval, restart, patch-import, ledger, and stale-host boundaries:

```bash
bun install --frozen-lockfile
docker pull node:24-bookworm-slim
bun run build
bun run demo:hostile
```

The expected result is a schema-versioned JSON proof with `secretExcluded`, `networkDenied`, `exactlyOnceJournal`, and `staleHostImportBlocked` all set to `true`. Pass `--keep` to retain the disposable workspace for inspection. The complete scenario and evidence limits are documented in [docs/HOSTILE_REPOSITORY_DEMO.md](./docs/HOSTILE_REPOSITORY_DEMO.md).

## What 0.11 changes

- adds a dependency-free terminal presentation layer with redacted activity, complete approval cards, and durable `y`/`n`/`v`/`q` decisions;
- lets recovered chat sessions inspect and resolve their current approval with `/pending`, `/approve`, and `/deny` after restoring the exact persisted provider, routing, context, and OCI policy;
- loads bounded `AGENTS.md`, project context, rules, and progressively disclosed skills while binding their digests into durable compatibility;
- adds trusted application lifecycle hooks with versioned identities, bounded events, timeouts, and redacted failures; and
- exposes exact-script shell syntax only through explicit `--execution oci --oci-shell ask`, preserving denied network and the separate host-import approval.

## What 0.10 changed

- makes Node.js `>=22.13.0` the primary public CLI and library runtime while retaining Bun-compatible imports and Bun-managed contributor workflows;
- replaces `bun:sqlite` and `Bun.spawn` with `node:sqlite` and argv-only `node:child_process` boundaries without changing the durable SQLite file format;
- detects npm, pnpm, Yarn, or Bun from a pinned `packageManager` field or an unambiguous lockfile, defaults to npm, and rejects implicit pre/post lifecycle hooks that were not reviewed;
- moves the default enforced environment to `node:24-bookworm-slim`, executes its controller as Node ESM, and keeps custom Bun images available through explicit configuration; and
- adds Node-built CLI/library and installed-artifact smokes while retaining Bun compatibility coverage.

## What 0.9 changed

- reuses a freshness-checked topology index across file-list and search pages while reading current file bytes for every digest;
- adds bounded `read_files` and `search_many` tools that reduce model/tool round trips without parallelizing writes;
- reuses an inert controller-only OCI container within an acquired run, attests command execution and the canonical workspace seal in one cycle, skips exports for unchanged seals, and reseeds after failures or host-snapshot changes without weakening the reviewed host-import boundary;
- adds a reproducible workspace benchmark and observable index/OCI I/O counters; and
- introduces deterministic, offline-verifiable `ChangeEnvelope v1` documents bound to exact patch bytes, base identity, runtime policy, redacted checks, expiry, and optional approval/attestation references.

## What 0.8 changed

- updates the coordinated Zhivex SDK batch while retaining a single Core runtime identity;
- makes `gpt-5.6-luna` the OpenAI default, with Terra and Sol available through explicit model selection; and
- clarifies that calling an approval-gated tool is the model's approval request, so the runtime can persist and resume it.

## What 0.7 introduced

- the short `zhx` command, with `zhivex-harness` retained as a compatible alias;
- one-shot execution plus a durable interactive console with named sessions, fork/archive operations, safe resume, status, diff, review, and explicit context compaction;
- an extensible provider registry, provider/model selection, provisional native Gemini support, and repeatable per-role routes such as `--route reviewer=gemini`;
- redacted, sequence-numbered `--jsonl` events for automation, while `--json` keeps the final-document contract;
- versioned configuration and JSON output contracts;
- a local `doctor` command that diagnoses the runtime, repository package manager, workspace, Git, scripts, state, credentials, endpoints, and provider capabilities without making provider requests or exposing secret values;
- deterministic, cursor-paginated workspace listing and search with SHA-256 content digests;
- reviewed multi-file proposals and approved atomic application with stale-content rejection;
- approved moves plus recoverable quarantine and restore operations;
- an explicit, configurable allowlist of declared `package.json` checks executed through the repository's pinned or detected package manager;
- read-only inspection of staged, unstaged, renamed, deleted, and untracked Git state;
- per-process mutation audit evidence and a final diff summary;
- scoped SQLite run/memory state, idempotency, approval resumption, leases, and exactly-once tool journals;
- run list, redacted inspect/export, cancellation, and retention cleanup commands;
- production safety policy plus step, time, tool, token, and optional operator-priced cost budgets;
- bounded context compaction with durable records and a deterministic golden evaluation gate;
- fail-fast model capability requirements and deterministic library-side candidate selection;
- governed MCP over bounded HTTPS/loopback HTTP with explicit server/tool allowlists, permissions, timeouts, approvals, output limits, and environment-backed credentials;
- named explorer, implementer, tester, and reviewer subagents with independent durable budgets and promoted approvals;
- deterministic application-owned parallel read-only review groups with child progress, hierarchy, usage, and cost evidence;
- optional enforced Docker/Podman execution with a warm controller-only per-run container, no container network, a read-only root filesystem, non-root execution, dropped capabilities, bounded CPU/memory/PIDs/time/output, and an ephemeral secret-free workspace snapshot;
- argv-only allowlisted environment commands, isolated package checks, deterministic patch inspection, and a separate durable approval before importing changes into the host workspace;
- environment/image/policy fingerprint binding, cancellation cleanup, labeled orphan cleanup, retained audit artifacts, and installed-package plus real-runtime smoke gates;
- protection against path traversal, symlink escapes, unsafe state targets, secret-file reads, special files, concurrent non-overwrite races, and unbounded output;
- Linux/macOS CI, installed-tarball smoke coverage, and opt-in live-provider certification.

It does not include arbitrary host shell access, `stdio` MCP, permanent deletion, Git writes, a desktop UI, a remote worker, or a managed sandbox service. Without `--execution oci`, shell-class tools remain unavailable. The opt-in `--oci-shell ask` policy exposes approval-bound `sh` only inside OCI. With OCI enabled, repository tools, checks, and enabled subagents share the acquired snapshot; network MCP is rejected because it cannot truthfully satisfy the no-network execution policy.

## Requirements

- Node.js 22.13.0 or newer. Node 24 LTS is used by the default OCI image and release workflow.
- Git for repository status and diff inspection.
- At least one supported provider credential for real model execution.
- Docker or Podman plus a preloaded image when `--execution oci` is requested.

## Installation

Install the published Node-first `0.10.0` artifact with an exact version:

```bash
npx --yes --package=@zhivex-ai/harness@0.10.0 zhx --version
```

To exercise the source checkout, contributors use Bun for deterministic repository tooling while the built CLI itself runs on Node:

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run dev --version
```

Configure only the providers you plan to use:

```dotenv
OPENAI_API_KEY=...
MODEL_API_KEY=...
DASHSCOPE_API_KEY=...
GEMINI_API_KEY=...
```

`MODEL_API_KEY` is used by the Meta Model API. Qwen also accepts `QWEN_API_KEY`; `DASHSCOPE_API_KEY` takes precedence. Gemini also accepts `GOOGLE_GENERATIVE_AI_API_KEY`.

## Diagnose the environment

`doctor` is local and does not contact provider endpoints:

```bash
zhx doctor
zhx doctor --provider qwen --json
```

For a source checkout, replace `zhivex-harness` with `bun run dev`.

## Usage

Start the durable console with the ergonomic command, or use the long alias in existing scripts:

```bash
zhx
zhx chat --continue
zhivex-harness --version
```

Inside the console, `/help` lists `/provider`, `/model`, `/route`, `/status`, `/diff`, `/review`, `/resume`, `/pending`, `/approve`, `/deny`, `/compact`, `/new`, `/rename`, and `/exit`. Tool and step activity is rendered without tool payloads; approval cards sanitize terminal controls and keep governed edit/command payloads fully reviewable.

Project context engineering is enabled by default. A root `AGENTS.md` plus an optional `.zhivex/harness.json` can declare bounded context files, rule files, and progressively loaded `SKILL.md` directories. Disable discovery with `--no-project-context` or select another manifest with `--context-config`.

Show providers and detected configuration without printing secrets:

```bash
zhx providers
zhx providers --json
```

Run a task against the current directory:

```bash
zhivex-harness run --provider openai "review the repository and fix the tests"
zhivex-harness run --provider meta "document the current architecture"
zhivex-harness run --provider qwen "implement the pending endpoint"
zhx run --provider gemini "review the proposed implementation"
```

Operate on another workspace:

```bash
zhivex-harness run --provider qwen --workspace ../my-app "fix the typecheck errors"
```

Interactive mode:

```bash
zhx chat --provider meta
zhx chat --continue
zhx sessions list
```

Route only selected subagent roles; credentials are required only for providers actually instantiated:

```bash
zhx run --provider openai --route explorer=qwen --route reviewer=gemini \
  "implement the change, then review it independently"
```

Routing with `--max-cost-usd` remains rejected in `0.11.0`: aggregate usage cannot yet be priced correctly when roles use different models.

Writes and checks pause for approval. In a non-interactive execution, state is saved in `.zhivex-harness/runs/operations.sqlite`:

```bash
zhivex-harness resume <runId> --approve
zhivex-harness resume <runId> --deny
```

Duplicate external requests can share a durable run identity:

```bash
zhivex-harness run --idempotency-key issue-482 "fix the reported regression"
```

Operate on runs without loading a provider or requiring its credential:

```bash
zhivex-harness runs list --status waiting_approval
zhivex-harness runs inspect <runId> --json
zhivex-harness runs export <runId> --json
zhivex-harness runs cancel <runId> --reason "superseded"
zhivex-harness runs cleanup --before 2026-08-01T00:00:00Z
```

Operations are scope-bound. The defaults are tenant `local` and a namespace derived from the canonical workspace. Supply the same `--tenant`, `--user`, and `--namespace` values across run and operator commands. Migration, budgets, redaction, retention, and compatibility limits are documented in [docs/DURABLE_OPERATIONS.md](./docs/DURABLE_OPERATIONS.md).

Use governed MCP and bounded subagents explicitly:

```bash
zhivex-harness run --mcp-config examples/mcp-config.json "consult the allowed documentation tools"
zhivex-harness run --subagent explorer --subagent reviewer "analyze the boundary"
zhivex-harness review --reviewer explorer --reviewer reviewer --json "review the durable runtime"
```

MCP configuration, capability gates, child budgets, promoted approvals, review groups, migration, and known limits are documented in [docs/EXTENSIBILITY.md](./docs/EXTENSIBILITY.md).

`--yes` automatically approves tools with side effects. Use it only inside a disposable or isolated workspace:

```bash
zhivex-harness run --provider openai --yes "apply the change and validate it"
```

Structured automation output uses schema version `1`:

```bash
zhivex-harness run --provider qwen --json "analyze the issue without modifying files"
zhx run --provider gemini --jsonl "analyze the issue without modifying files"
```

The JSON shapes and exit codes are documented in [docs/CLI.md](./docs/CLI.md).

Create a portable change-admission envelope from structured, redacted evidence and the exact patch bytes, then verify it without provider credentials or network access:

```bash
zhx changes create examples/change-envelope-input.json --patch examples/change.patch > change-envelope.json
zhx changes verify change-envelope.json --patch examples/change.patch
```

The verifier proves integrity, expiry, and explicit preconditions; it deliberately reports approval and external-attestation authenticity as `not-verified`. See [docs/CHANGE_ENVELOPES.md](./docs/CHANGE_ENVELOPES.md).

Repository edits use digest-bound proposals. Discovery returns `nextCursor` when another deterministic page is available; mutating tools reject stale content instead of merging or overwriting it. Deletions move files into harness-owned quarantine and return a recovery identifier. The complete contract and migration from `0.2.x` are documented in [docs/REPOSITORY_EDITING.md](./docs/REPOSITORY_EDITING.md).

The default check allowlist is `test`, `typecheck`, `lint`, and `build`. Replace it with repeatable CLI flags when a repository uses different declared scripts:

```bash
zhivex-harness run --allow-check test:unit --allow-check format "apply the fix and validate it"
```

The harness uses a pinned `packageManager` field when present; otherwise it accepts one unambiguous npm, pnpm, Yarn, or Bun lockfile and defaults to npm when neither signal exists. It executes only the selected script and rejects symbolic-link or ambiguous lockfiles plus implicit `pre<script>`/`post<script>` lifecycle hooks.

Enable enforced local execution explicitly. The image must already exist locally; the harness never pulls it implicitly:

```bash
docker pull node:24-bookworm-slim
zhivex-harness doctor --execution oci
zhivex-harness run --execution oci --yes "inspect, implement, test, review the environment patch, and import it"
zhivex-harness run --execution oci --oci-shell ask "use a reviewed shell pipeline inside the isolated snapshot"
```

`--yes` approves eligible command execution and the distinct host patch import; it cannot enable a shell whose policy is `deny`. Omit it when a human should review each durable approval. Configuration, threat boundary, cleanup, and certification details are in [docs/EXECUTION_ENVIRONMENTS.md](./docs/EXECUTION_ENVIRONMENTS.md).

## Providers and defaults

| Provider | Default model | Current support |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` · 0.6 edit, delegation, and OCI execution certified |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` · 0.6 edit, delegation, and OCI execution certified |
| OpenAI | `gpt-5.6-luna` | `OPENAI_API_KEY` · GPT-5.6 Luna, Terra, and Sol base workflow passed locally; release recertification pending |
| Gemini | `gemini-3.6-flash` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` · provisional until the harness live matrix passes |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, `OPENAI_BASE_URL`, and `GEMINI_BASE_URL`. Non-credential transport settings are hash-bound to durable resumes without persisting their values.

Meta and Qwen retain the published support conclusion for the unchanged approval/restart and delegation paths. OpenAI remains GPT-5.6-first from `0.8.0`: Luna is the default, while Terra and Sol remain explicit `--model` selections. The tagged Node-first `0.10.0` artifact is published; the `0.11.0` candidate requires its own clean CI, live-provider, artifact, registry, and provenance gates. Controlled and official-SDK MCP interoperability are verified separately and do not imply compatibility with every server or protocol feature. Provider capability claims remain artifact- and date-bound under the [live certification contract](./docs/LIVE_CERTIFICATION.md); credential detection and deterministic tests do not replace real provider evidence.

## Security boundaries

- Every workspace path is resolved against a canonical root.
- Reads and writes that cross an external symlink are rejected.
- Dependencies, build output, Git internals, harness state, `.env`, `.npmrc`, and private keys are excluded from model exploration.
- The model has no generic shell.
- Only explicitly allowed, declared package scripts can run; the model must provide the exact script text for approval binding.
- Checks run without automatic `.env` loading and with a reduced environment.
- Patch application, moves, quarantine, restore, and command execution require interruptible approval.
- Every edit carries the digest observed during inspection; stale creates and updates fail closed.
- Existing file modes are preserved and successful replacements are published atomically.
- Unsafe state roots, protected workspace paths, files, and symlink targets are rejected before a run store is created.
- Environment values are not injected into prompts, diagnostics, or tool responses.
- Remote MCP output is bounded, schema-checked, treated as untrusted, and rejected on common prompt-injection directives.
- Network MCP always pauses for approval; custom read-only annotation trust must be explicit and injected by the host application.
- Subagent children inherit scope, workspace, cancellation, approval, and store policy while retaining independent budgets and fingerprints.
- OCI execution binds the durable run to the resolved image identity and enforced policy; resume fails if either changes.
- Snapshot discovery excludes secrets, Git internals, harness state, dependency trees, and build output. Dependencies may be mounted separately read-only.
- Untrusted commands receive a quota-backed tmpfs workspace, never a writable host bind; only successful, frozen, validated snapshots replace durable environment state.
- Container processes receive no provider credentials or arbitrary host environment values, and host changes require a separately approved digest-bound patch import.

The default `none` backend provides governance but no OS isolation and therefore exposes no shell-class tool. The local OCI backend enforces the documented container boundary, but it is not a VM or a managed hostile-code sandbox; use a dedicated host or microVM when the container runtime itself is outside the threat model.

## Development

```bash
bun run typecheck
bun test
bun run build
bun run evaluate
bun run benchmark:workspace
bun run benchmark:workspace -- --files 50000 --repetitions 10 --warmups 2
bun run benchmark:oci -- --files 1000 --commands 20 --repetitions 10 --warmups 1
bun run benchmark:safe-fix:ci
bun run smoke:package
bun run pack:inspect
bun run check
```

The workspace benchmark reports topology-only and digest-bound listing separately, plus independent versus batched search with alternating pair order. The OCI benchmark reports environment setup, snapshot/session acquisition, first command, reused commands, mutation, and end-to-end time to first successful command. Both fixtures exclude setup, validate results, use sequential repetitions, and emit host/runtime metadata, nearest-rank p50/p95/p99, and success rates. `--repetitions` and `--warmups` are configurable; host filesystem caches are not flushed, so publish the commit and exact command with any result. Use at least 100 successful samples before treating p99 as representative.

The [Time-to-Safe-Fix benchmark](./docs/TIME_TO_SAFE_FIX.md) adds task-level clean/attacked matrices, `safeResolved` scoring, approval/system latency separation, Wilson rate intervals, and matched overhead against a direct profile. Its bundled deterministic smoke validates only the benchmark pipeline. Public capability or safety claims require a real external driver, exact dataset revision, matched model/runtime controls, and disclosed failures.

Full generated reports remain local and Git-ignored under [`results`](./results/). Commit only digest-verified, sanitized evidence snapshots under [`benchmarks/baselines`](./benchmarks/baselines/).

The live gate is opt-in and billable:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:routing
```
