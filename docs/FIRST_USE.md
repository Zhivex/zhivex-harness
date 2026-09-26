# First use

This guide targets the unpublished `1.2.0-rc.5` candidate. Installation commands become available after protected publication to npm `next`; stable users can install `@zhivex-ai/harness@latest`.

## Install and start

Install Node.js 22.13.0 or newer and Git. Then:

```sh
npm install -g @zhivex-ai/harness@1.2.0-rc.5
cd /path/to/your/project
zhx
```

When no default profile or explicit provider/model exists, `zhx` selects the only
provider with an environment key. If none or several are available, it offers a
searchable provider and model selector, with a recommended default and custom
model entry. Escape goes back; cancelling setup leaves profiles unchanged.
The selector saves your choice in a private user profile outside the repository;
auto-detection from an environment key does not create a profile. The console then offers a hidden API key prompt: save in the system
keychain or use only for this CLI session. Profiles themselves never contain keys.
Use `/menu` → **Credentials** to replace or remove keys. See [Credentials](CREDENTIALS.md).
On later bare `zhx` launches, the console uses the saved `default` provider/model
automatically, without asking again. To always start with Qwen, run
`zhx init --update --provider qwen`. Add `--model <id>` to select a model.
Use `--provider` or `--profile` at launch, or the console's provider/model
selector, for a temporary change.

## Environment keys for automation

| Provider | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`) |
| Meta | `MODEL_API_KEY` |
| Gemini (provisional) | `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) |

For example, enter an OpenAI key without echoing it or putting it in shell history:

```sh
# macOS zsh
read -rs 'OPENAI_API_KEY?OpenAI API key: '
export OPENAI_API_KEY
```

This configures the current shell only. Use your shell or secret manager's normal
secure mechanism for subsequent shells. Do not paste keys into conversations.
If you already have credentials, explicitly select a provider with
`zhx init --profile default`, or start with `zhx --provider qwen`.

`zhx doctor` uses the same default profile or single environment-provider detection
as the conversation. It shows the selected provider/model and checks environment
or keychain credential presence without contacting the provider. The human report
focuses on the selected provider; JSON retains all provider checks. Missing or
unavailable selected credentials produce exit code 3. The first model request is
what tests actual account access.

If secure storage fails, choose **Use a temporary key** or retry without restarting.
When setup finishes, the console shows one welcome, the credential source and the
approval policy before your first task.

## Work and continue

Ask: “Explain this repository and suggest a small improvement.” Type `/` to find
common actions; type more characters to search all available commands.

- `/model`: choose a model.
- `/sessions`: find previous conversations.
- `/attach <path>`: attach a file excerpt to your next request.
- `/diff`: inspect changes.
- `/help`: common commands and approval actions; `/help all`: advanced commands.

Review the exact actions before approving. `/pending` shows pending approvals;
`/approve` accepts them and `/deny` rejects them. Ctrl+C stops active work without
undoing completed effects. Run `zhx --continue` to reopen the latest conversation.

For an isolated exercise, follow the [worked example](FIRST_USE_EXAMPLE.md).
For command execution, configure [OCI isolation](EXECUTION_ENVIRONMENTS.md).

## Other installation methods

With Bun 1.4.0 or newer and a supported Node runtime:

```sh
bun add --global @zhivex-ai/harness@1.2.0-rc.5
zhx
```

For a disposable version/help/environment check without a global installation:

```sh
bunx @zhivex-ai/harness@1.2.0-rc.5 --version
bunx @zhivex-ai/harness@1.2.0-rc.5 --help
bunx @zhivex-ai/harness@1.2.0-rc.5 doctor
```

For source development, use the [contributor guide](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md).
