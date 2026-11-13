# Standalone web retirement

Status: implemented in the working tree, 2026-11-13.

Zhivex Assistant (Tauri) is the primary graphical interface. Code remains the
terminal product. The native pilot currently supports macOS Apple Silicon only;
this change does not certify a production distribution or other platforms.

## Supported entrypoints

- Build the native application with `bun run --cwd packages/assistant build:desktop`.
  Open `packages/assistant/src-tauri/target/release/bundle/macos/Zhivex Assistant.app`.
- Use `zhivex-code` for interactive terminal work and existing history/state commands.
- Use `zhivex-assistant --directory PATH --owner ID` for an advanced foreground host.
  Run `zhivex-assistant --help` for provider, integration and project options.
- `zhivex-code project` preserves the legacy registry operations. Tauri registers
  projects separately; this command does not import that registry into Assistant.

`zhivex-code web` and Assistant's `--setup`, `--open`, `--web`, and `--web-port`
entrypoints now stop with migration guidance. Assistant with no arguments prints
help. The old browser launcher is no longer built. Existing installed launchers
and already-running services are not modified by a source checkout update.

## Components retained for Tauri

`packages/assistant/web` is the shared React interface embedded by Tauri.
`packages/assistant/src/web` supplies onboarding and the authenticated loopback
server. These remain required. The `build:web`, `dev:web` and browser smoke scripts
are development/verification tools for that embedded interface, not standalone
product entrypoints. Web search, OAuth browser redirects and static project previews
remain available.

Code builds no longer depend on `packages/web` or ship browser assets. Release
inspection rejects the retired browser payload. CLI tests, installed PTY journeys
and engine acceptance remain release gates. Assistant's shared UI checks remain in
its own workflow. The old Code web workflow is removed; repositories with a required
branch-protection check for that workflow must remove that stale requirement.

Legacy web sources and reports remain in `packages/web` for reference, outside
active builds and CI. They are not a supported application. Do not use their old
scripts as acceptance checks for current Code artifacts.

## State and recovery

Quit the old managed web launcher/service before opening Tauri. Retain `~/.zhx-app`
at its existing path so provider keychain bindings and Assistant history remain
valid. This retirement deletes no user state, credentials, exports or installed app.
Keep incompatible Code history with its original CLI owner. No scope rewriting or
automatic data migration is performed. See [the pilot runbook](ASSISTANT_TAURI_STAGE_7.md)
for backup, adoption and rollback boundaries and [the native guide](ASSISTANT_DESKTOP.md)
for lifecycle and packaging.

## Validation for this change

- Code: 172 tests passed, including retired-entrypoint and CLI-build regressions.
- Assistant: 227 tests passed with local socket access; the sandbox-only attempt
  failed on socket permissions and was repeated outside that restriction.
- Architecture and release regressions: 32 tests passed.
- Code and Assistant typechecks, architecture checks and documentation checks passed.
- The actual Code tarball passed release inspection with no browser assets.
- The Tauri app rebuilt successfully. Its packaged Node runtime passed fresh-state
  startup, assets, bearer authentication, duplicate ownership, shutdown, restart
  and parent-pipe EOF checks. This is runtime smoke evidence, not a new visual
  native-window certification or a real-provider test.

No installed application was replaced, no user service was stopped, and no commit,
push or publication was performed by this change.
