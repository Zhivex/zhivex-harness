# Contributing

Zhivex Harness publishes a Node-first runtime and uses Bun for deterministic contributor tooling. Install dependencies and run the complete local gate with:

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
