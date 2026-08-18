# Zhivex Harness

**Governed execution for coding agents.**

[![npm](https://img.shields.io/npm/v/%40zhivex-ai%2Fharness?logo=npm)](https://www.npmjs.com/package/@zhivex-ai/harness)
[![CI](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.7-fbf0df?logo=bun)](https://bun.sh/)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

![Zhivex Harness: Let agents work. Control every change.](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/assets/social-preview.png)

Zhivex Harness runs coding agents against real repositories with conflict-safe edits, durable approvals, isolated execution, and redacted operational evidence. It is a Bun-first local CLI and TypeScript library portable across Meta, Qwen, and OpenAI, built on the Stable `@zhivex-ai/agents` runtime.

The model provides capability. The harness controls what it may inspect, execute, change, resume, and prove. Every provider uses the same bounded tool and approval contract.

Version `0.6.1` is the public positioning and hostile-repository proof patch for the `0.6.x` enforced-execution line. Its exact npm tarball, `latest` tag, and SLSA workflow provenance were verified against source tag `v0.6.1`. See [ROADMAP.md](./ROADMAP.md), [CHANGELOG.md](./CHANGELOG.md), the [execution-environment guide](./docs/EXECUTION_ENVIRONMENTS.md), the [extensibility guide](./docs/EXTENSIBILITY.md), the [durable-operations guide](./docs/DURABLE_OPERATIONS.md), and the [trusted-editing contract](./docs/REPOSITORY_EDITING.md).

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
docker pull oven/bun:1.3.7-slim
bun run build
bun run demo:hostile
```

The expected result is a schema-versioned JSON proof with `secretExcluded`, `networkDenied`, `exactlyOnceJournal`, and `staleHostImportBlocked` all set to `true`. Pass `--keep` to retain the disposable workspace for inspection. The complete scenario and evidence limits are documented in [docs/HOSTILE_REPOSITORY_DEMO.md](./docs/HOSTILE_REPOSITORY_DEMO.md).

## What 0.6 includes

- one-shot execution and interactive chat;
- provider and model selection through the CLI;
- versioned configuration and JSON output contracts;
- a local `doctor` command that diagnoses Bun, workspace, Git, scripts, state, credentials, endpoints, and provider capabilities without making provider requests or exposing secret values;
- deterministic, cursor-paginated workspace listing and search with SHA-256 content digests;
- reviewed multi-file proposals and approved atomic application with stale-content rejection;
- approved moves plus recoverable quarantine and restore operations;
- an explicit, configurable allowlist of declared `package.json` checks executed through Bun;
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
- optional enforced Docker/Podman execution with no container network, a read-only root filesystem, non-root execution, dropped capabilities, bounded CPU/memory/PIDs/time/output, and an ephemeral secret-free workspace snapshot;
- argv-only allowlisted environment commands, isolated package checks, deterministic patch inspection, and a separate durable approval before importing changes into the host workspace;
- environment/image/policy fingerprint binding, cancellation cleanup, labeled orphan cleanup, retained audit artifacts, and installed-package plus real-runtime smoke gates;
- protection against path traversal, symlink escapes, unsafe state targets, secret-file reads, special files, concurrent non-overwrite races, and unbounded output;
- Linux/macOS CI, installed-tarball smoke coverage, and opt-in live-provider certification.

It does not include arbitrary host shell access, `stdio` MCP, permanent deletion, Git writes, a desktop UI, a remote worker, or a managed sandbox service. Without `--execution oci`, shell-class tools remain unavailable. With OCI enabled, repository tools, checks, and enabled subagents share the acquired snapshot; network MCP is rejected because it cannot truthfully satisfy the no-network execution policy.

## Requirements

- Bun 1.3.7 or newer.
- Git for repository status and diff inspection.
- At least one supported provider credential for real model execution.
- Docker or Podman plus a preloaded image when `--execution oci` is requested.

## Installation

```bash
bun add @zhivex-ai/harness
bunx zhivex-harness --version
```

To exercise the `0.6.1` source checkout:

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
```

`MODEL_API_KEY` is used by the Meta Model API. Qwen also accepts `QWEN_API_KEY`; `DASHSCOPE_API_KEY` takes precedence.

## Diagnose the environment

`doctor` is local and does not contact provider endpoints:

```bash
zhivex-harness doctor
zhivex-harness doctor --provider qwen --json
```

For a source checkout, replace `zhivex-harness` with `bun run dev`.

## Usage

Show providers and detected configuration without printing secrets:

```bash
zhivex-harness providers
zhivex-harness providers --json
```

Run a task against the current directory:

```bash
zhivex-harness run --provider openai "review the repository and fix the tests"
zhivex-harness run --provider meta "document the current architecture"
zhivex-harness run --provider qwen "implement the pending endpoint"
```

Operate on another workspace:

```bash
zhivex-harness run --provider qwen --workspace ../my-app "fix the typecheck errors"
```

Interactive mode:

```bash
zhivex-harness chat --provider meta
```

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
```

The JSON shapes and exit codes are documented in [docs/CLI.md](./docs/CLI.md).

Repository edits use digest-bound proposals. Discovery returns `nextCursor` when another deterministic page is available; mutating tools reject stale content instead of merging or overwriting it. Deletions move files into harness-owned quarantine and return a recovery identifier. The complete contract and migration from `0.2.x` are documented in [docs/REPOSITORY_EDITING.md](./docs/REPOSITORY_EDITING.md).

The default check allowlist is `test`, `typecheck`, `lint`, and `build`. Replace it with repeatable CLI flags when a repository uses different declared scripts:

```bash
zhivex-harness run --allow-check test:unit --allow-check format "apply the fix and validate it"
```

Enable enforced local execution explicitly. The image must already exist locally; the harness never pulls it implicitly:

```bash
docker pull oven/bun:1.3.7-slim
zhivex-harness doctor --execution oci
zhivex-harness run --execution oci --yes "inspect, implement, test, review the environment patch, and import it"
```

`--yes` approves both command execution and the distinct host patch import. Omit it when a human should review each durable approval. Configuration, threat boundary, cleanup, and certification details are in [docs/EXECUTION_ENVIRONMENTS.md](./docs/EXECUTION_ENVIRONMENTS.md).

## Providers and defaults

| Provider | Default model | Current support |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` · 0.6 edit, delegation, and OCI execution certified |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` · 0.6 edit, delegation, and OCI execution certified |
| OpenAI | `gpt-5.4` | `OPENAI_API_KEY` · 0.6 edit, delegation, and OCI execution certified |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, and `OPENAI_BASE_URL`.

Meta, Qwen, and OpenAI completed the final `0.6.0` model-directed OCI command/review/import matrix together at `2026-08-17T16:49:12.975Z`, the proposal/approval/restart refresh at `2026-08-17T16:22:34.885Z`, and the delegation/persistence/hierarchy refresh at `2026-08-17T16:24:14.381Z`. Controlled Streamable HTTP MCP interoperability over a real loopback server passed at `2026-08-17T16:48:09.043Z`; independent interoperability with `@modelcontextprotocol/server@2.0.0` passed at `2026-08-17T16:48:09.141Z` in its legacy-stateless compatibility mode. These results do not imply compatibility with every server or protocol feature. Provider capability claims are date-bound by the [live certification gate](./docs/LIVE_CERTIFICATION.md); credential detection and deterministic tests do not replace real provider evidence.

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
bun run smoke:package
bun run pack:inspect
bun run check
```

The live gate is opt-in and billable:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
```
