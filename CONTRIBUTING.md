# Contributing

Zhivex Harness publishes a Node-first runtime and uses Bun for deterministic contributor tooling. For local CLI development:

```sh
bun install --frozen-lockfile
# If .env does not exist, copy .env.example to .env and configure one provider key.
bun run dev
```

`dev` builds and starts the console under Node, loading `.env` when present.
`bun run start` opens the existing build without rebuilding or loading `.env`.
See [Desktop development](desktop/DEVELOPMENT.md) for the separate app.

## Validation

Run the complete local gate with:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun audit
bun pm untrusted
bun run pack:inspect
```

Behavior changes should include focused success, failure-path, and security regression coverage. Update the README, relevant contract guide, changelog, and migration notes when a public CLI, configuration, persisted-state, JSON, or library contract changes.

Live provider and MCP checks are opt-in and must be reported separately from deterministic and installed-artifact proof. Never commit credentials, `.env`, provider outputs containing secrets, or local `.zhivex-harness` state.

Publishing is performed only through the protected `release.yml` GitHub Actions workflow after an annotated tag, exact-artifact verification, and explicit maintainer confirmation. Do not publish from a development checkout.

## Documentation and maintenance

See the [maintenance index](docs/MAINTENANCE.md) for design notes, benchmarks,
release procedures and the documentation language and packaging policy.

## Credential storage checks

`bun test tests/cli-credentials.test.ts` uses fake stores and synthetic keys.
`bun run smoke:credentials` checks the native system store using a random account
under `ai.zhivex.harness.cli.test` and removes it afterward; it never reads CLI or
Desktop accounts. macOS requires an accessible Keychain. Linux requires an unlocked
Secret Service in a D-Bus session. CI configures a disposable Linux store.

PTY onboarding tests set `ZHIVEX_HARNESS_CREDENTIAL_STORE=disabled`; they verify
temporary entry and replacement with a local transport fixture. No provider is called.
