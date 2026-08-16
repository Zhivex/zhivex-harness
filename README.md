# Zhivex Harness

Zhivex Harness is a Bun-first coding-agent harness portable across Meta, Qwen, and OpenAI, built on the Stable `@zhivex-ai/agents` runtime.

The model provides capability; the harness provides repository context, narrow tools, limits, approvals, durable state, diagnostics, and verification. Every provider uses the same agent loop and local-tool contract.

Version `0.3.0` is an active private development milestone. It is intentionally blocked from registry publication while trusted repository editing is completed and dogfooded. The validated `0.2.0` source baseline is preserved by the local `v0.2.0` tag. See [ROADMAP.md](./ROADMAP.md), [CHANGELOG.md](./CHANGELOG.md), and the [trusted-editing contract](./docs/REPOSITORY_EDITING.md).

## What 0.3 includes

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
- durable run state and approval resumption;
- protection against path traversal, symlink escapes, unsafe state targets, secret-file reads, special files, concurrent non-overwrite races, and unbounded output;
- Linux/macOS CI, installed-tarball smoke coverage, and opt-in live-provider certification.

It does not include arbitrary shell access, permanent deletion, Git writes, MCP, subagents, a desktop UI, or a managed sandbox. Tools run inside the workspace with the permissions of the local process.

## Requirements

- Bun 1.3.7 or newer.
- Git for repository status and diff inspection.
- At least one supported provider credential for real model execution.

## Installation

The project is private and is not published to a package registry. Run the source checkout:

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

Writes and checks pause for approval. In a non-interactive execution, state is saved under `.zhivex-harness/runs`:

```bash
zhivex-harness resume <runId> --approve
zhivex-harness resume <runId> --deny
```

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

## Providers and defaults

| Provider | Default model | Current support |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` · Certified for 0.3 tools |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` · Certified for 0.3 tools |
| OpenAI | `gpt-5.4` | `OPENAI_API_KEY` · Certified for 0.3 tools |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, and `OPENAI_BASE_URL`.

Meta, Qwen, and OpenAI have completed the 0.3 proposal, approval, restart, and exactly-once patch gate. Provider capability claims are date-bound by the [live certification gate](./docs/LIVE_CERTIFICATION.md). Credential detection and deterministic tests do not replace real provider evidence.

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

These controls reduce risk but do not provide strong isolation. Use a dedicated container or microVM and a disposable workspace for autonomous execution.

## Development

```bash
bun run typecheck
bun test
bun run build
bun run smoke:package
bun run pack:inspect
bun run check
```

The live gate is opt-in and billable:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
```
