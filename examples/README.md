# Examples for Zhivex Harness 1.1

## Isolated Bun installation

Requirements: Bun 1.4.0+, Node.js 22.13.0+, and Git on macOS or Linux. This installs the published stable artifact in a temporary consumer, without building the source checkout or changing global tools:

```bash
harness_demo_dir=$(mktemp -d)
cd "$harness_demo_dir"
printf '{"name":"harness-first-run","private":true}\n' > package.json
bun add --exact --ignore-scripts @zhivex-ai/harness@1.2.0-rc.5
./node_modules/.bin/zhx --version
./node_modules/.bin/zhx --help
./node_modules/.bin/zhx doctor --provider openai --json
```

Version must print `1.2.0-rc.5`; help lists commands. Doctor does not contact a provider. Without `OPENAI_API_KEY`, it reports the missing credential and exits with code `3`; inspect the JSON checks before proceeding. A directory without Git initialization can also produce a diagnostic warning. No paid model call is required for these checks. Both `zhx` and `zhivex-harness` are installed aliases; Bun manages installation, and their shebang runs Node.

To continue in your actual project, use the [global installation and credential setup](../README.md#installation), then `zhx init --profile daily --provider openai` and `zhx doctor --profile daily`. Real tasks require the selected provider credential in the process environment. Profiles store provider/model choices, never credentials. See [CLI](../docs/CLI.md) and [support](../SUPPORT.md).

## Configuration and change examples

- [MCP configuration](./mcp-config.json): optional bounded network MCP integration; see [extensibility](../docs/EXTENSIBILITY.md).
- [Change envelope input](./change-envelope-input.json) and [patch](./change.patch): illustrative data for [change envelopes](../docs/CHANGE_ENVELOPES.md). Digests and timestamps are sample evidence, not certification of a current workspace; generate fresh evidence for real changes.

Earlier versions and RC evidence belong to the [changelog](../CHANGELOG.md) and [historical reports](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/README.md), not the first-run installation path.
