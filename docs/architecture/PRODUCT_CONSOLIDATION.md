# Harness, terminal and Tauri

The supported products are the Harness engine, the Code terminal and Assistant
(Tauri). Electron and the independent Code web application are retired. Their
historical implementation is available at Git revision `612af25`; the checkout
no longer installs, builds, packages or tests those applications.

## Ownership and compatibility

- `src/runtime`, `src/persistence`, `src/client` and the other engine domains own
  execution, policies, approvals, budgets and durable state. Public `/engine`,
  `/protocol`, `/client` and `/service` exports remain independent of terminal UI.
- `src/cli` owns the single terminal implementation. `packages/code` supplies the
  `zhivex-code` executable, its product version and project registry commands.
  Its source compatibility facades contain no second console implementation.
- `/terminal` and `/terminal/*` are terminal-only integration entrypoints, not
  engine APIs or stable embedding contracts. They are built in the same graph as
  the engine so approvals, task budgets and host identity are never duplicated.
- `zhx` and `zhivex-harness` remain compatibility executables in the Harness
  distribution. They use the same terminal implementation, retain their engine
  version identity, and preserve existing scripts and state locations.
- `packages/assistant` owns the application host and Tauri shell. Its React UI
  and authenticated loopback server remain required embedded components.

The existing 1.6.3/0.4.2 manifests are development candidates. Publication needs
new compatible versions: the Code candidate requires the new terminal exports.
Do not publish it against an older registry Harness with the same version label.
Installed-consumer verification must use the exact local candidate artifacts.

## Existing histories

Retirement performs **no user-data migration or deletion**. It does not move
SQLite databases, rewrite tenant/user/namespace scopes, reset credentials, remove
worktrees, uninstall old apps, or modify `~/.zhx-app`. Close the owning application
before opening its store through another client. Never remove a live owner lock.

Ordinary Electron project runs used the engine's default workspace state directory
and scope. Code and the compatibility executables can inspect that same history:

```sh
zhivex-code sessions list --workspace /absolute/repository --json
zhivex-code sessions inspect SESSION_ID --workspace /absolute/repository --json
zhivex-code runs inspect RUN_ID --workspace /absolute/repository --json
```

For a nondefault store, include `--state-dir /absolute/existing/state`. Preserve
any original `--tenant`, `--user` and `--namespace` values; a different scope shows
a different history. Resume also requires the original compatible runtime/provider
binding; listing history is not permission to replay an effect or approve work.

Electron's application-data directory contains `projects/projects.json` and
`tasks/tasks.json`. Keep the entire directory, not only the main SQLite
file: task records contain their original `workspace` and `stateDirectory`. Use
those exact paths with the commands above for isolated task history. Keep worktree
checkouts and branches. Auxiliary visual activity, delivery journals and model
settings are retained on disk; the terminal does not render every old UI field.

Tauri retains its existing `~/.zhx-app` identity and per-project Assistant scopes.
It does not silently adopt Code/Electron histories into its different scopes.
[The pilot runbook](../assistant/ASSISTANT_TAURI_STAGE_7.md) defines compatible export/adoption
and backup rules. Incompatible histories stay accessible with the CLI and their
original state/scope. Preserve the previous complete installed application as a
fallback until any pending work is resolved and backups have been verified.

## Validation and CI

Core tests no longer require Electron or renderer dependencies. Whole-database
backup regression tests now live in `tests/host-database-backup.test.ts`; they
retain WAL, auxiliary table, index and lease checks. Assistant retains its domain
approval, worktree, delivery, lifecycle and release tests.

Assistant CI includes a macOS arm64 native job with locked Cargo tests, a Tauri
app build, and a smoke test against the Node runtime inside the actual app bundle.
The runner label follows [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
This gate is unsigned local packaging, not production notarization or publication.
See [production preparation](../assistant/ASSISTANT_TAURI_PRODUCTION.md) for remaining gates.

Production continues using Node and `node:sqlite`, with unchanged schemas.
Bun tests on macOS load Homebrew SQLite through `tests/preload-runtime.ts`; install
it with `brew install sqlite`, or set `BUN_SQLITE_LIBRARY` to a trusted absolute
library path. This fixes Apple SQLite's read-only WAL behavior in the test runtime
without changing the production driver or falling back to writable reads. See
[Bun's SQLite library configuration](https://bun.sh/docs/runtime/sqlite).
An orphaned local npm 2.15.12 installation found during validation was moved out
of `node_modules`; it was not in the lockfile and suppressed requested scripts.
Fresh immutable installs must not restore it.

## Local verification — 2026-11-13

- `bun run check`: passed, including 2,177 core tests, architecture, documentation,
  contracts, types, historical migrations, offline evaluations, benchmarks, MCP
  smoke tests and the isolated installed package.
- Code: 173 tests passed; the isolated candidate-package journey passed.
- Assistant: 227 tests passed; native Rust: 5 tests passed.
- Both root console PTY smoke scripts passed, including setup, saved profiles,
  literal paste, queued input, interruption, payload review and approval restart.
- The final macOS arm64 Tauri app built successfully. Its bundled runtime passed
  authentication, assets, duplicate ownership, shutdown, restart and parent-EOF checks.
- Added history fixtures verify default/custom scopes and the legacy executable
  aliases without modifying user stores. Backup tests preserve auxiliary tables,
  indexes and WAL state and reject active ownership and tampering.

The local OCI smoke was skipped because Docker was not running; Linux CI still
requires it. This verification did not run hosted CI, make live provider calls,
visually inspect the native window, sign/notarize the application or publish a
release. Existing user histories were neither migrated nor deleted.
