# Zhivex Harness

**Work on your code with an agent. Review consequential actions before approving them.**

Zhivex Harness is a local terminal assistant and TypeScript library. It supports
OpenAI, Qwen and Meta, with provisional Gemini, Anthropic and Vertex support. Conversations and pending
approvals survive restarts.

Use it to understand a repository, discuss a design, investigate a failure or
implement a change. Conversation context retains decisions, hypotheses and bounded
diagnostic excerpts across compaction. Edits and command execution keep their
own permission checks; a conversational summary never grants approval.

For the developer-facing terminal product, install
`npm install -g @zhivex-ai/code@0.2.0` and run `zhivex-code` in your project.
See [Code installation and first use](https://github.com/Zhivex/zhivex-harness/blob/main/packages/code/README.md). Harness remains
the reusable engine and its compatibility CLI. The `/task` delivery workflow in
this checkout is an unreleased experimental Code addition, not a published feature.

Version `1.3.0` is the current public npm release on `latest`, with terminal-independent engine
entrypoints and the separately published Code CLI `0.2.0` on `latest`. Harness publication passed registry integrity and provenance verification. Harness `1.4.0-rc.6` and
Code `0.3.0-rc.6` are published on `next`. Annotated `v1.4.0-rc.7` was tagged but
not published after live certification failed. The RC.8 versions prepared in this
checkout remain unpublished. Stable package numbering does
not change API stability tiers: beta and experimental APIs retain their policies,
Gemini/Anthropic/Vertex remain provisional, and Desktop remains a private alpha.

## Quick start

Requires Node.js 22.13.0 or newer, Git and a provider API key.

Install the stable npm release (`latest`, currently `1.3.0`):

```sh
npm install -g @zhivex-ai/harness@latest
cd /path/to/your/project
zhx
```

On first use, choose a provider and model, then enter your API key in the hidden
prompt. Save it in the system keychain (macOS/Linux) or use it only for the current
CLI session. Existing environment keys take precedence. See [First use](docs/FIRST_USE.md)
and [Credentials](docs/CREDENTIALS.md) for setup and automation.

Try: “Explain this repository and suggest a small improvement.”

Type `/` for common actions. `/model` changes the model, `/sessions` finds previous
conversations, and `/diff` shows changes. Review requested actions before approving
them. Ctrl+C stops active work; it does not undo completed changes.

## Release candidates

This checkout prepares Harness `1.4.0-rc.8` and Code `0.3.0-rc.8` for `next`, with an exact engine pin. Project memory, compact terminal review and the local browser workspace ship together after protected validation. See the [release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md). RC.8 publication is pending. It includes the reviewed duplicate-delegation fix on main after RC.7. Published npm `next` is Harness `1.4.0-rc.6` and Code `0.3.0-rc.6`. Annotated `v1.4.0-rc.7` was tagged but not published after Qwen live certification failed; that source and tag cannot certify RC.8. The held RC.5 campaign and failed RC.4 attempt remain preserved. These prerelease candidates are separate from the stable `latest` channel.

Use candidates only for prerelease validation. Check [npm versions](https://www.npmjs.com/package/@zhivex-ai/harness?activeTab=versions)
and the [release procedure](https://github.com/Zhivex/zhivex-harness/blob/main/docs/RELEASE.md)
before installing a candidate; `next` can still point to an earlier RC.

After publication of this exact candidate:

```sh
npm install -g @zhivex-ai/harness@1.4.0-rc.8
```

## A few commands are enough

| Command | Purpose |
| --- | --- |
| `zhx` | Open the conversation |
| `zhx --continue` | Continue the latest conversation |
| `zhx run "task"` | Run one task for automation |
| `zhx doctor` | Diagnose local configuration |
| `zhx --help` | Show the short guide |

Use `zhx <command> --help` for command-specific options, or `zhx help all` for the
complete reference. Existing `zhx chat` and `zhivex-harness` commands remain supported.

## CLI, library or Desktop?

The npm package includes the CLI and TypeScript library. [Desktop](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md)
is a separate Electron application, currently alpha for macOS Apple Silicon.
It is not included in npm and has its own build and distribution process. Its local
package is unsigned and unnotarized; automatic updates are disabled pending production trust setup and validation.

## Permissions and limits

Edits and checks require approval by default. Files such as `.env`, private keys,
Git internals and dependency directories are excluded from model exploration.
The default runtime has no OS isolation and exposes no shell-class tools. Running
commands in isolation requires an explicitly configured Docker or Podman environment;
see [Execution environments](docs/EXECUTION_ENVIRONMENTS.md).

Gemini, [Anthropic](docs/ANTHROPIC.md) and [Vertex](docs/VERTEX.md) remain provisional. See the [support matrix](docs/SUPPORT_MATRIX.md) and
[security policy](SECURITY.md) for supported configurations and reporting concerns.

## Documentation

- **Users:** [First use](docs/FIRST_USE.md), [daily workflow](docs/CLI.md#interactive-daily-workflow), [usage reference](docs/USAGE.md).
- **Integrators:** [CLI contracts](docs/CLI.md), [extensibility](docs/EXTENSIBILITY.md), [API stability](docs/STABILITY.md).
- **Contributors:** [Development](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md) and [maintenance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/MAINTENANCE.md).

[Browse documentation](docs/README.md).

Version `1.3.0` is the current public npm release. Source checkout changes can be
newer than the published package. Consult the [changelog](CHANGELOG.md) and
[repository release status](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json)
for the verified 1.3.0 publication; [release evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md)
records validation scope and limitations.

Experimental next-version work includes [project memory](docs/PROJECT_MEMORY.md): explicit, reviewable notes scoped to one project, with bounded retrieval and deletion controls.
