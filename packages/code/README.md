# Zhivex Code

The terminal product for [Zhivex Harness](https://github.com/Zhivex/zhivex-harness). Code is what you install and use. Harness is the governed, provider-portable runtime underneath: durable approvals and isolated execution.

<!-- TODO(Miguel): same GIF as the repository README. Replace this placeholder URL
     after you record it. Do not add the image file to this package or to `files`. -->

![Approval survives a restart](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/docs/images/TODO-approval-survives-restart.gif)

> **TODO(Miguel):** placeholder URL. Record the GIF and replace this link before launch. Keep the file out of the package `files` list.

OpenAI, Qwen, and Meta are the release-gated providers. Gemini, Anthropic, and Vertex are provisional. Linux and macOS only. Node.js 22.13 or newer. You do not need Bun to run the published package.

The repository [README](https://github.com/Zhivex/zhivex-harness/blob/main/README.md) is the product overview. This page is the package guide.

## Install

Stable installs follow npm `latest`:

```sh
npm install -g @zhivex-ai/code
```

Equivalent global installs: `pnpm add -g @zhivex-ai/code`, `yarn global add @zhivex-ai/code` (Yarn Classic), and `bun add -g @zhivex-ai/code`. For a project-local install, use that project's package manager with `@zhivex-ai/code`.

Code owns `zhivex-code`. Harness keeps `zhx`, `zhivex-harness`, and `zhx-acp`. Installing both leaves each command in place. Code has no public library API.

## First run

```sh
cd /path/to/your/project
zhivex-code
```

Choose a provider and model. Enter an API key in the hidden prompt, or rely on an environment variable you already exported. Save the key in the system keychain or keep it for this session. Review each edit and check before you approve it. Provider calls can cost money. `/usage` and `/budget` report estimates for each run. They are not invoices, and they are not a cap across a whole session.

Credential details, including Vertex Application Default Credentials, are in [Credentials](https://github.com/Zhivex/zhivex-harness/blob/main/docs/CREDENTIALS.md). The [first-use guide](https://github.com/Zhivex/zhivex-harness/blob/main/docs/FIRST_USE.md) shows the same prompts with the engine command `zhx`.

```sh
zhivex-code --help
zhivex-code init
zhivex-code run --json "Explain this repository"
zhivex-code doctor
```

## Continue

Pending approvals are stored in SQLite and survive quitting the terminal.

| Where | What you type | What happens |
| --- | --- | --- |
| Shell, after you quit | `zhivex-code --continue` | Reopens the latest conversation, including a pending approval. Inspect it with `/pending`, then `/approve` or `/deny`. |
| Inside the session | `/continue` | Starts a new run from an interrupted task and keeps the earlier results. |

`/continue` is the in-session slash command. `--continue` is the shell flag that reopens the latest conversation. It exists on `zhivex-code` and on the engine CLI `zhx`. A run that is waiting for approval stays on `/pending` until you decide. A new turn, `/continue`, or review group gets a new per-run budget. Resuming a pending run keeps that run's original limit. There is no session-wide financial cap.

`zhivex-code --session <id>` reopens one selected conversation.

## Offline tutorial

The package includes a tutorial that needs Node.js 22.13 or newer and an interactive terminal. It does not need Bun, Git, credentials, or a paid provider. From a global install:

```sh
node "$(npm root -g)/@zhivex-ai/code/examples/first-use.mjs"
```

From a local install of a packed tarball:

```sh
npm install --ignore-scripts /absolute/path/to/zhivex-ai-code.tgz
node node_modules/@zhivex-ai/code/examples/first-use.mjs
```

The launcher creates a temporary workspace and walks through inspect, checkpoint, a per-run budget, a reviewed diff, a reviewed Node test, `/usage`, Ctrl+C, exit, reopen, and `/continue`. Model responses are synthetic. The console, persistence, approvals, file edits, and the Node check still run. The script prints the command that reopens the same workspace.

## Commands worth knowing

Approvals for reviewed edits show a per-file changed-region diff when the engine can preview it. The full approval payload stays available. Oversized or unavailable previews are labeled. The engine rechecks preconditions when it applies the change.

`/checkpoint` captures, lists, reviews, or restores explicitly selected existing UTF-8 text files (1–20 files, at most 64 KiB each):

```text
/checkpoint capture ["src/greeting.mjs", "src/greeting.test.mjs"]
/checkpoint list
/checkpoint review
/checkpoint restore
```

Restore shows current contents, captured contents, and current digests. Type `prepare` to adopt those preconditions, then `restore` on the second review to apply them. Conflicts and missing files fail closed.

`/pricing` shows advisory USD prices from the shared catalog, including scope and source. Missing prices say `unknown`. `/budget` or `/budget 1` sets an estimated USD limit for each new run. `/budget off` clears that limit. `--pricing-file` and `--usage-limit-usd` are the automation flags. Estimates can differ from provider bills.

## Limits

- Gemini, Anthropic, and Vertex are provisional. See the [support matrix](https://github.com/Zhivex/zhivex-harness/blob/main/docs/SUPPORT_MATRIX.md).
- Anthropic uses `ANTHROPIC_API_KEY` or `/credentials`. Vertex uses host Application Default Credentials with `GOOGLE_CLOUD_PROJECT` and `VERTEX_LOCATION`. Code does not store a Vertex API key.
- MCP in the default CLI is bounded Streamable HTTP. stdio is not enabled from workspace JSON.
- `zhivex-code web` opens an experimental local browser workspace on macOS or Linux. Configure credentials in the CLI first. See [local web client](https://github.com/Zhivex/zhivex-harness/blob/main/packages/web/README.md) and `zhivex-code web --help`.
- The default runtime exposes no shell tools. Isolated commands need Docker or Podman, configured explicitly.

## Releases

npm `latest` is the stable channel (Code `0.2.0`, paired with Harness `1.3.0`). Prerelease publication moves independently. Confirm dist-tags on [npm](https://www.npmjs.com/package/@zhivex-ai/code?activeTab=versions) before you install a candidate.

Channels, publication, and certification records: [Harness release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md) and [Code release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/CODE_RELEASE.md). Releases are verified with npm provenance. Package history is in the [changelog](CHANGELOG.md).

## Contributors

Bun is contribution tooling. The published tarball runs on Node.js 22.13 or newer without Bun, TypeScript, or install scripts.

From this directory, after a compatible Harness package and the declared dependencies are installed:

```sh
bun install --cwd ../web --frozen-lockfile --ignore-scripts
bun run build
bun run typecheck
bun test tests
```

In a repository checkout, install the root lockfile with `bun install --frozen-lockfile --ignore-scripts`, build at the repository root, then run `bun run packages/code/scripts/link-local-engine.ts`. That links the built engine into Code's ignored `node_modules` for local API work. It does not run as an install script, and it does not bundle engine source. Installed acceptance must use the Harness version this package declares.

`bun run smoke:installed` packs Code, installs it with npm and that pinned Harness dependency, and exercises the offline tutorial in a Linux or macOS terminal. To reuse an existing tarball: `node scripts/installed-journey.mjs /absolute/path/to/code.tgz`.
