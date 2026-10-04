# Zhivex Harness

**Work on your code with an agent. Review consequential actions before approving them.**

Zhivex Harness is a local terminal assistant and TypeScript library. It supports
OpenAI, Qwen and Meta, with provisional Gemini, Anthropic and Vertex support. Conversations and pending
approvals survive restarts.

Use it to understand a repository, discuss a design, investigate a failure or
implement a change. Conversation context retains decisions, hypotheses and bounded
diagnostic excerpts across compaction. Edits and command execution keep their
own permission checks; a conversational summary never grants approval.

Version `1.3.0` is the current public npm release on `latest`, with terminal-independent engine
entrypoints and the separately published Code CLI `0.1.0` on `latest`. Both protected
workflows passed registry integrity and provenance verification. Harness RC7 and
Code RC2 remain published on `next`. Stable package numbering does
not change API stability tiers: beta and experimental APIs retain their policies,
Gemini/Anthropic/Vertex remain provisional, and Desktop remains a private alpha.

Code `0.2.0` is being prepared with the same exact Harness `1.3.0` dependency.
Its guided console workflows and offline tutorial are described in the
[Code candidate guide](https://github.com/Zhivex/zhivex-harness/blob/main/packages/code/README.md); publication is pending.

## Quick start

Requires Node.js 22.13.0 or newer, Git and a provider API key.

Install the published stable release:

```sh
npm install -g @zhivex-ai/harness@1.3.0
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
