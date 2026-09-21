# First use

## Install and start

Install Node.js 22.13.0 or newer and Git. Then:

```sh
npm install -g @zhivex-ai/harness@1.0.0
cd /path/to/your/project
zhx
```

When no default profile or provider credentials exist, `zhx` asks you to choose a
provider and model. It stores that selection in a private user profile outside the
repository. The console then offers a hidden API key prompt: save in the system
keychain or use only for this CLI session. Profiles themselves never contain keys.
Use `/menu` → **Credentials** to replace or remove keys. See [Credentials](CREDENTIALS.md).

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

`zhx doctor` checks local configuration and environment key presence without contacting the
provider. Missing credentials produce exit code 3. The first model request is
what tests actual account access.

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
bun add --global @zhivex-ai/harness@1.0.0
zhx
```

For a disposable version/help/environment check without a global installation:

```sh
bunx @zhivex-ai/harness@1.0.0 --version
bunx @zhivex-ai/harness@1.0.0 --help
bunx @zhivex-ai/harness@1.0.0 doctor
```

For source development, use the [contributor guide](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md).
