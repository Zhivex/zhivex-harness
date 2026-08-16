# Zhivex Harness

The first version of a coding-agent harness portable across Meta, Qwen, and OpenAI, built on the stable `@zhivex-ai/agents` runtime.

The core idea is simple: the model provides capability; the harness provides repository context, tools, limits, approvals, durable state, and verification. All three providers use the same agent loop and tool contract.

## What the MVP includes

- one-shot execution and interactive chat;
- provider and model selection through the CLI;
- bounded workspace listing, search, and reading;
- file creation and exact replacement with human approval;
- `test`, `typecheck`, `lint`, and `build` through `package.json` scripts and Bun;
- read-only inspection of `git status` and `git diff`;
- durable run state and approval resumption;
- protection against path traversal, symlink escapes, and secret-file reads;
- size, output, step, and time limits.

It does not yet include arbitrary shell access, file deletion or renaming, MCP, subagents, a desktop UI, or a managed sandbox. Tools run inside the workspace with the permissions of the local process.

## Installation

Bun 1.3.7 or newer is required.

```bash
bun install
cp .env.example .env
```

Configure at least one credential:

```dotenv
OPENAI_API_KEY=...
MODEL_API_KEY=...
DASHSCOPE_API_KEY=...
```

`MODEL_API_KEY` is used by the Meta Model API. Qwen also accepts `QWEN_API_KEY`; `DASHSCOPE_API_KEY` takes precedence.

## Usage

Show providers and detected configuration without printing secrets:

```bash
bun run dev providers
```

Run a task against the current directory:

```bash
bun run dev run --provider openai "review the repository and fix the tests"
bun run dev run --provider meta "document the current architecture"
bun run dev run --provider qwen "implement the pending endpoint"
```

Operate on another workspace:

```bash
bun run dev run --provider qwen --workspace ../my-app "fix the typecheck errors"
```

Interactive mode:

```bash
bun run dev chat --provider meta
```

Writes and checks pause the run for approval. In a non-interactive execution, state is saved under `.zhivex-harness/runs`:

```bash
bun run dev resume <runId> --approve
bun run dev resume <runId> --deny
```

`--yes` automatically approves tools with side effects. Use it only inside a disposable or isolated workspace:

```bash
bun run dev run --provider openai --yes "apply the change and validate it"
```

Structured output for automation:

```bash
bun run dev run --provider qwen --json "analyze the issue without modifying files"
```

## Providers and defaults

| Provider | Default model | Credential |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` |
| OpenAI | `gpt-5.4` | `OPENAI_API_KEY` |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, and `OPENAI_BASE_URL`.

## MVP security

- Every path is resolved against a canonical workspace root.
- Reads and writes that cross an external symlink are rejected.
- Dependencies, build output, Git internals, harness state, `.env`, `.npmrc`, and private keys are excluded from exploration.
- The model is not given access to a generic shell.
- Only scripts with allowed names can run; the model must provide the exact script text so it is visible during approval.
- Checks run without automatic `.env` loading and with a reduced environment.
- Writes, replacements, and command execution require interruptible approval.
- Environment variables are not injected into prompts or tool responses.

These controls reduce risk but do not provide strong isolation. Use a dedicated container or microVM and a disposable workspace for autonomous execution.

## Development

```bash
bun run typecheck
bun test
bun run build
bun run check
```
