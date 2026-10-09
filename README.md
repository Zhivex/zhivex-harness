# Zhivex Code

[![npm @zhivex-ai/code](https://img.shields.io/npm/v/@zhivex-ai/code?label=npm%20%40zhivex-ai%2Fcode)](https://www.npmjs.com/package/@zhivex-ai/code)
[![CI](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Zhivex/zhivex-harness)](LICENSE)

An open-source coding agent for your terminal. It asks before it edits or runs a check, and a pending approval is still there after you quit.

**Zhivex Code** ([`@zhivex-ai/code`](https://www.npmjs.com/package/@zhivex-ai/code)) is the product you install and run. **Zhivex Harness** ([`@zhivex-ai/harness`](https://www.npmjs.com/package/@zhivex-ai/harness)) is the engine underneath: a governed, provider-portable TypeScript runtime with durable approvals and isolated execution. MIT licensed.

## Approval survives a restart

<!-- Recorded with zhivex-code. Scene: ask for a change, review the diff, leave the approval pending, quit,
     then run `zhivex-code --continue` and show the same approval.
     Inside the session, `/continue` starts a new run from an interrupted task;
     the reopen step in this GIF is the `--continue` flag.
     The file is docs/images/approval-survives-restart.gif. Do not add it to either package `files` list.
     npm shows the absolute raw URL below. That URL resolves from main. -->

![Approval survives a restart](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/docs/images/approval-survives-restart.gif)

## Why it works this way

- **You approve the exact change.** Edits and checks wait for an explicit decision bound to that diff. A conversational summary leaves the change unapproved. If the file changed on your side, import fails closed.
- **The pending decision survives a restart.** Conversations and approvals are stored in SQLite. Quit the terminal, or reboot, and the same approval is waiting.
- **Your keys, your provider.** OpenAI, Qwen, and Meta pass the release gate. Gemini, Anthropic, and Vertex are provisional. The same CLI talks to each of them.

## Quick start

You need Node.js 22.13 or newer, Git, and a provider API key. Linux and macOS are supported. Windows is unsupported.

```sh
npm install -g @zhivex-ai/code
cd /path/to/your/project
zhivex-code
```

On first launch, choose a provider and model. If no key is already available, enter one in the hidden prompt and save it in the system keychain, or keep it for this session only. An existing environment variable takes precedence. The same prompts are documented for the engine command `zhx` in [First use](docs/FIRST_USE.md) and [Credentials](docs/CREDENTIALS.md).

Try: “Explain this repository and suggest a small improvement.”

Type `/` for common actions. `/model` changes the model, `/sessions` finds earlier conversations, and `/diff` shows workspace changes. Review each requested action before you approve it. Ctrl+C stops the active run. It leaves completed work in place.

| Command | Purpose |
| --- | --- |
| `zhivex-code` | Open the conversation |
| `zhivex-code --continue` | Reopen the latest conversation. A pending approval opens the review screen |
| `zhivex-code run "task"` | Run one task for a script |
| `zhivex-code doctor` | Check local configuration |
| `zhivex-code --help` | Short guide |
| `zhivex-code help all` | Full command reference |

`zhivex-code <command> --help` shows one command. Inside the session, `/help` lists everyday actions and `/help all` lists the rest.

### Command names

Each package owns its own commands. Installing both leaves each command in place. Nothing here adds or renames a command.

| Package | Commands |
| --- | --- |
| `@zhivex-ai/code` | `zhivex-code` |
| `@zhivex-ai/harness` | `zhx` and `zhivex-harness` (the same engine CLI), plus `zhx-acp` for the experimental editor protocol |

`zhx chat` remains a supported way to open the engine console.

### A pending approval is still there

Two different actions share the word “continue”:

| Where | What you type | What happens |
| --- | --- | --- |
| Shell, after you quit | `zhivex-code --continue` | Reopens the latest conversation. A pending approval opens the review screen. |
| Inside the session | `/continue` | Starts a new run from an interrupted task and keeps the earlier results. |

`/continue` is the in-session command. The shell flag that reopens the latest conversation is `--continue`, on `zhivex-code` and on `zhx`. On `zhivex-code`, that screen is `r` Reject, `a` Approve N file(s), `d` Details, and Esc to decide later. A check uses `Approve 1 command` instead of the file label. `/pending` opens the same screen. A new turn waits until you decide. On `zhx`, `--continue` reopens and prints the pending approval; `/pending`, then `/approve` or `/deny`, decides it. `/continue` inside that session starts a new run.

### Try it with no API key

The Code package includes an offline tutorial. It needs an interactive terminal. It makes no provider calls. Responses, token counts, and prices are synthetic.

```sh
node "$(npm root -g)/@zhivex-ai/code/examples/first-use.mjs"
```

The script prints the guided sequence and a command to reopen the same temporary workspace.

### Credentials

| Provider | What the CLI accepts |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` |
| Meta | `MODEL_API_KEY` |
| Gemini (provisional) | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| Anthropic (provisional) | `ANTHROPIC_API_KEY` |
| Vertex (provisional) | Application Default Credentials, plus `GOOGLE_CLOUD_PROJECT` and `VERTEX_LOCATION`. Code does not ask for a Vertex API key. |

Use `/credentials` later to replace or remove a saved key. `zhivex-code doctor` reports whether a credential is present. It does not call the provider.

## What you can count on

| | |
| --- | --- |
| Approval | Explicit, bound to the exact diff. Per-file changed regions are shown when a preview is available. |
| Durability | SQLite keeps the conversation and any pending approval across quit and reboot. |
| Secrets | `.env`, private keys, Git internals, and dependency directories stay out of model exploration. |
| Commands | The default runtime exposes no shell tools. Isolated commands need an explicitly configured Docker or Podman environment. |
| Where it runs | On your machine. Linux and macOS. |

From a source checkout, `bun run demo:hostile` runs a reproducible hostile-repository demo (a malicious README and a decoy `.env`, with network denied). See [Hostile repository demonstration](docs/HOSTILE_REPOSITORY_DEMO.md). That demo needs a local build, Docker or Podman, and a preloaded image.

## Providers and platforms

Release-gated providers are OpenAI, Qwen, and Meta. **Gemini, Anthropic, and Vertex are provisional**: the integrations exist, and they do not yet have the same end-to-end release evidence. Details: [support matrix](docs/SUPPORT_MATRIX.md), [Anthropic](docs/ANTHROPIC.md), [Vertex](docs/VERTEX.md).

| Area | Status |
| --- | --- |
| Operating systems | Linux and macOS. Windows is unsupported. |
| Runtime | Node.js 22.13 or newer. Bun is contributor tooling. |
| MCP | Bounded Streamable HTTP is supported. stdio is outside the default CLI. An experimental host-only path can launch stdio servers in Docker; see [Isolated MCP stdio](docs/MCP_STDIO.md). |
| Editor protocol | `zhx-acp` is an experimental ACP subset: text sessions, one-time permissions, and cancellation. Output is buffered until the run finishes. ACP cannot load or resume a session. See [ACP](docs/ACP.md). |
| Isolated commands | Docker on Linux is supported. Podman is provisional. See [Execution environments](docs/EXECUTION_ENVIRONMENTS.md). |
| Desktop | Separate private alpha for macOS Apple Silicon. Unsigned, and not part of the npm package. See [Desktop](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md). |

## Use the engine as a library

Code is the terminal product and has no public library API. Harness is the embeddable runtime. Hosts construct it, supply credentials, and resolve approvals:

```ts
import { createHarness } from "@zhivex-ai/harness/engine";
import { createHarnessClientAdapter } from "@zhivex-ai/harness/client";

const harness = await createHarness({
  workspace: "/absolute/path/to/project",
  provider: "openai",
  model: "your-supported-model"
});
const client = await createHarnessClientAdapter(harness);
try {
  // Dispatch with the client protocol. Approve each consequential action explicitly.
} finally {
  client.close();
  await harness.close();
}
```

Contracts, stability tiers, and the experimental ACP and MCP entry points are in the [engine API](docs/ENGINE_API.md).

## Documentation

- **Using Code:** [Code package notes](https://github.com/Zhivex/zhivex-harness/blob/main/packages/code/README.md), [first use](docs/FIRST_USE.md), [daily workflow](docs/CLI.md#interactive-daily-workflow), [usage reference](docs/USAGE.md).
- **Integrating Harness:** [engine API](docs/ENGINE_API.md), [CLI contracts](docs/CLI.md), [extensibility](docs/EXTENSIBILITY.md), [API stability](docs/STABILITY.md).
- **Limits:** [support matrix](docs/SUPPORT_MATRIX.md), [security policy](SECURITY.md).
- **Contributing:** [development](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md) and [maintenance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/MAINTENANCE.md).

[Browse the documentation index](docs/README.md).

## Releases

Version `1.3.0` is the current public npm release. The paired Code package on npm `latest` is `0.2.0`. This checkout prepares Version `1.4.0` and Code `0.3.0` for `latest`. That publication is pending, so the quick start above follows the published `latest` tag. npm `next` is Harness `1.4.0-rc.8` and Code `0.3.0-rc.8`. Confirm dist-tags on the [Code versions](https://www.npmjs.com/package/@zhivex-ai/code?activeTab=versions) and [Harness versions](https://www.npmjs.com/package/@zhivex-ai/harness?activeTab=versions) pages before you install a prerelease.

Release channels, publication, and certification records are in the [release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md). Releases are verified with npm provenance. Source in this checkout can be newer than the public package. See the [changelog](CHANGELOG.md) and the [repository release status](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json).
