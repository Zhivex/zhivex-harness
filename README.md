# Zhivex Harness

**Governed execution for coding agents.**

[![npm](https://img.shields.io/npm/v/%40zhivex-ai%2Fharness?logo=npm)](https://www.npmjs.com/package/@zhivex-ai/harness)
[![CI](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

![Zhivex Harness: Let agents work. Control every change.](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/assets/social-preview.png)

Zhivex Harness runs coding agents against real repositories with conflict-safe edits, durable approvals, isolated execution, and redacted operational evidence. It is a Node-first local CLI and TypeScript library portable across Meta, Qwen, OpenAI, and provisional Gemini support, built on the Stable `@zhivex-ai/agents` runtime. Bun remains supported as development tooling and as an explicitly selected repository package manager.

The model provides capability. The harness controls what it may inspect, execute, change, resume, and prove. Every provider uses the same bounded tool and approval contract.

Version `1.0.0` is the current source release candidate for stable publication; it is not yet published. The latest public stable release remains `0.11.1`, and `1.0.0-rc.14` is published on `next`. RC.14 passed protected live certification and 42/42 representative cases; its security review is complete under the explicit [user-delegated AI exception](./docs/RC14_DELEGATED_SECURITY_DECISION.md), not an independent human audit. The [repository release status](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json) records the pending stable candidate. Stable publication requires its own deterministic, installed-package, OCI, live-provider and representative gates and verified provenance. See the [readiness gate](./docs/GA_READINESS.md), [API stability policy](./docs/STABILITY.md), [support matrix](./docs/SUPPORT_MATRIX.md), [threat model](./docs/THREAT_MODEL.md), [roadmap](./ROADMAP.md) and [changelog](./CHANGELOG.md).

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

## What RC.13 adds

- explicit personal provider/model profiles through `zhx init` and `--profile`, stored outside the repository without credentials;
- Tab command completion, previewed multiline tasks, bounded task history, and Alt+Enter input;
- `/context` inspection and bounded, digest-checked `/attach` excerpts for the next task;
- Ctrl+C cancellation with runtime cleanup and preserved pending approvals, plus recovery to the prompt after command/provider errors; and
- terminal-safe Markdown and optional colored diffs, with unsolicited input discarded before approval prompts.

See the [RC.13 changelog and migration notes](./CHANGELOG.md#100-rc13---2026-09-03) and [interactive workflow guide](./docs/CLI.md#interactive-daily-workflow). No configuration or store migration from RC.12 is required.

Earlier release changes and migrations are recorded in the [changelog](./CHANGELOG.md). Browse the [documentation index](./docs/README.md) for usage, architecture, maintenance, and historical reports.

It does not include arbitrary host shell access, `stdio` MCP, permanent deletion, Git writes, a desktop UI, a remote worker, or a managed sandbox service. Without `--execution oci`, shell-class tools remain unavailable. The opt-in `--oci-shell ask` policy exposes approval-bound `sh` only inside OCI. With OCI enabled, repository tools, checks, and enabled subagents share the acquired snapshot; network MCP is rejected because it cannot truthfully satisfy the no-network execution policy.

## Requirements

- Node.js 22.13.0 or newer. Node 24 LTS is used by the default OCI image and release workflow.
- Git for repository status and diff inspection.
- At least one supported provider credential for real model execution.
- Docker or Podman plus a preloaded image when `--execution oci` is requested.

## Installation

Run the Node-first `latest` release with an exact version:

```bash
bunx @zhivex-ai/harness@0.11.1 --version
```

To try the published RC.13 candidate on `next`, pin its exact version:

```bash
bunx @zhivex-ai/harness@1.0.0-rc.13 --version
bunx @zhivex-ai/harness@1.0.0-rc.13 init --profile daily --provider openai
bunx @zhivex-ai/harness@1.0.0-rc.13 doctor --profile daily
bunx @zhivex-ai/harness@1.0.0-rc.13 --profile daily "inspect this repository"
```

RC.13 is a prerelease; publication on `next` does not promote it to GA.

To exercise the source checkout, contributors use Bun for deterministic repository tooling while the built CLI itself runs on Node:

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run dev --version
```

RC.13 includes first-run setup that stores only a provider and model in an explicit personal profile. From a source checkout:

```bash
bun run dev init --profile daily --provider openai
bun run dev doctor --profile daily
bun run dev --profile daily "inspect this repository"
```

Installed builds expose the same flow as `zhx init`. Profiles are private user configuration outside the repository, use owner-only permissions, contain no credentials, and are never selected implicitly. CLI flags override the selected profile; the selected profile overrides environment variables; environment variables override built-in defaults.

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
zhx doctor --profile daily
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

The published RC.13 also adds Tab command completion, `/paste` for previewed
multiline tasks, `/context` for active project rules/skills, and `/attach <path>` for
bounded file excerpts. Ctrl+C interrupts active work while retaining the session;
errors return to the prompt. See the [interactive workflow](./docs/CLI.md#interactive-daily-workflow)
for attachment limits, approval behavior, and recovery. These source additions are
not yet published or live-certified.

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

Routing with `--max-cost-usd` remains rejected in `0.11.1`: aggregate usage cannot yet be priced correctly when roles use different models.

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

| Provider | Default model | Support in `latest` (`0.11.1`) |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` · 0.11.1 release-bound base, delegation, and OCI execution certified |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` · 0.11.1 release-bound base, delegation, routing, and OCI execution certified |
| OpenAI | `gpt-5.6-luna` | `OPENAI_API_KEY` · 0.11.1 release-bound base, delegation, routing, and OCI execution certified |
| Gemini | `gemini-3.6-flash` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` · provisional until the harness live matrix passes |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, `OPENAI_BASE_URL`, and `GEMINI_BASE_URL`. Non-credential transport settings are hash-bound to durable resumes without persisting their values.

The exact `v0.11.1` tag passed proposal/approval/restart, bounded delegation, OpenAI-parent/Qwen-reviewer routing, and model-directed OCI execution for Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, and OpenAI `gpt-5.6-luna` on 2026-08-23. Luna remains the OpenAI default, while Terra and Sol remain explicit `--model` selections with older local base evidence only. Controlled and official-SDK MCP interoperability are verified separately and do not imply compatibility with every server or protocol feature. Provider capability claims remain artifact- and date-bound under the [live certification contract](./docs/LIVE_CERTIFICATION.md); credential detection and deterministic tests do not replace real provider evidence.

For `next`, the exact `v1.0.0-rc.13` artifact passed protected live certification and all 14 representative cases for each of Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, and OpenAI `gpt-5.6-luna` on 2026-09-08. See the [RC.13 release evidence](./docs/LIVE_CERTIFICATION.md#current-public-status) for the workflow and artifact identity. Gemini remains provisional.

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
bun run readiness:1.0
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

Full generated reports remain local and Git-ignored under `./results/` (source checkout). Commit only digest-verified, sanitized evidence snapshots under [`benchmarks/baselines`](./benchmarks/baselines/).

The live gate is opt-in and billable:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:routing
```
