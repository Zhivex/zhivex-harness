# Zhivex Harness

**Work on your code with an agent. Review consequential actions before approving them.**

Zhivex Harness is a local terminal assistant and TypeScript library. It supports
OpenAI, Qwen and Meta, with provisional Gemini support. Conversations and pending
approvals survive restarts.

This development branch prepares `1.1.0-rc.2` (unpublished), with console, local
service and Desktop preview improvements. The commands below install stable 1.0.0.

## Quick start

Requires Node.js 22.13.0 or newer, Git and a provider API key.

```sh
npm install -g @zhivex-ai/harness@1.0.0
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

Gemini remains provisional. See the [support matrix](docs/SUPPORT_MATRIX.md) and
[security policy](SECURITY.md) for supported configurations and reporting concerns.

## Documentation

- **Users:** [First use](docs/FIRST_USE.md), [daily workflow](docs/CLI.md#interactive-daily-workflow), [usage reference](docs/USAGE.md).
- **Integrators:** [CLI contracts](docs/CLI.md), [extensibility](docs/EXTENSIBILITY.md), [API stability](docs/STABILITY.md).
- **Contributors:** [Development](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md) and [maintenance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/MAINTENANCE.md).

[Browse documentation](docs/README.md).

Version `1.0.0` is the current public npm release. Source checkout changes can be
newer than the published package. Consult the [changelog](CHANGELOG.md) and
[repository release status](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json)
for release identity; [release evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md)
records validation scope and limitations.
