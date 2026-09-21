# Desktop development

Desktop uses Electron and React with Harness in a separate process. The sidebar
and welcome view use the original mark in `assets/zhivex-logo.png`. See
[Architecture](../docs/DESKTOP_ARCHITECTURE.md) and [client protocol](../docs/CLIENT_PROTOCOL.md).

## Run from source

From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun run --cwd desktop build
bun run --cwd desktop start
# Optional starting repository:
bun run --cwd desktop start --workspace /absolute/repository
```

CI installs dependencies with `--ignore-scripts`, then explicitly runs
`node desktop/node_modules/electron/install.js` from the repository root. This
installs the pinned, checksum-verified Electron binary needed by native tests;
other dependency lifecycle scripts remain disabled.

## Validate and package

```sh
bun run --cwd desktop typecheck
bun test desktop/tests
bun run --cwd desktop package
bun run --cwd desktop smoke:packaged --empty-start
bun run desktop/scripts/smoke.ts --models --packaged
bun run --cwd desktop smoke:restart:packaged
bun run --cwd desktop smoke:worktrees:packaged
bun run desktop/scripts/smoke-layout.ts --packaged
bun run desktop/scripts/smoke-layout.ts --packaged --credentials
bun run desktop/scripts/smoke-layout.ts --packaged --updates
```

The app is written to `desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app`.
Packaging npm does not build or publish Desktop. These offline tests use temporary
repositories and model fixtures, covering isolation, streaming, cancellation,
reviews, persistence, recovery, models, keyboard interaction and chat geometry.
Reports and screenshots go to temporary directories.

Additional checks:

```sh
# Simulated runtime; does not certify real Docker:
bun run --cwd desktop smoke:packaged --oci-review
# Native helpers and runtime with temporary Keychains:
bun run desktop/scripts/smoke-native-credentials.ts
# Prepare and check the unsigned local installer:
bun run desktop/scripts/prepare-installer.ts
bun run desktop/scripts/smoke-installer.ts
```

## Models and credential tests

```sh
bun test desktop/tests/model-selection.test.ts desktop/tests/credential-store.test.ts
bun run desktop/scripts/smoke.ts --models
```

The offline smoke checks IPC, runtime selection, session persistence, reload,
approvals and layout. It does not certify provider accounts. The native helper
self-test verifies account isolation in a temporary Keychain. Fixtures do not read
or modify the personal Keychain.

## Optional live Qwen test

```sh
bun --env-file=.env run desktop/scripts/live-qwen-smoke.ts --live
```

This billable test uses the packaged app, three turns and a temporary repository.
It verifies tool-based reads, renderer output, chat continuation and an edit awaiting
approval. It restarts the runtime before approval and checks final bytes. The `.env`
key travels through the helper's private channel; the test does not write or replace
personal Keychain credentials.

Its main process is a test driver connecting the packaged renderer and runtime.
It does not certify the production main's complete setup flow, other models or
endpoints. The overall limit is six minutes with no full-test retry. The report
contains only outcomes and the failed phase, if any. Real Docker, live GitHub auth
and signed distribution require separate verification.
