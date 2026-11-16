# Electron development

Electron opens the unified Assistant/Code shell and consumes an installed core artifact. The root Bun workspace lockfile owns all three packages and the native packaging dependency overrides.

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
node packages/desktop/node_modules/electron/install.js
bun run prepare:desktop
bun run --cwd packages/desktop build
bun run --cwd packages/desktop start
```

`prepare:desktop` builds and installs the exact core tarball in `packages/desktop/.harness`, preserving any prior dependency. Builds record its version and SHA-256; packaging rejects a different candidate. This is independent of a registry release.

```sh
bun run --cwd packages/desktop typecheck
bun test packages/desktop/tests
bun run --cwd packages/desktop package
bun run --cwd packages/desktop smoke:packaged
bun run packages/desktop/scripts/smoke-bundled-core.mjs
bun run packages/desktop/scripts/smoke-assistant.mjs
bun run packages/desktop/scripts/smoke-mac-verifier.ts
bun run packages/desktop/scripts/smoke-application-swap.ts
```

The app is written to `packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app`. Offline smokes use temporary repositories, local models, and an in-memory SecretStore. They cover approvals, checkpoints, checks, worktrees, local commits, cancellation and recovery. Reports and screenshots are written to temporary directories.

The former desktop UI, Tauri launcher and browser packages have been removed. Shared service, credential, backup, update and recovery modules remain covered by their regression tests. No build migrates personal profiles or enables production updates.

See [application migration](../../docs/APPLICATION_MIGRATION.md), [architecture](../../docs/DESKTOP_ARCHITECTURE.md) and [client protocol](../../docs/CLIENT_PROTOCOL.md). Signing/notarization and production update certification remain separate.
