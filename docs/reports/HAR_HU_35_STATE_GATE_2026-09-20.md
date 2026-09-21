# HU35: desktop state compatibility gate

The main process now calls `checkDesktopStateFormat` before opening project/task
registries, creating a window, launching runtimes or performing recovery.
`userData/state-compatibility/format.json` declares the desktop state format and
whether it is ready or migrating. Current format is 1. A missing marker is
initialized privately without replacing a concurrent writer's marker; existing
project and conversation data is not modified by initialization.

Unsupported formats are rejected with `DESKTOP_STATE_INCOMPATIBLE`, interrupted
migrations with `DESKTOP_STATE_RECOVERY_REQUIRED`, and malformed or unsafe markers
with `DESKTOP_STATE_INVALID`. The marker is never automatically reset on failure.
Reading uses a bounded descriptor, no-follow/nonblocking flags, ownership/type/
permission validation and a strict schema. Production displays a native error
dialog containing only fixed guidance and the sanitized code, then exits before
opening the state. The test mode writes only that code into an isolated report.

This introduces the compatibility boundary for future versions. Builds predating
this gate cannot retroactively honor the marker. There is no migration writer,
backup transaction or automatic recovery flow yet. The phase marker is a refusal
condition, not evidence that an actual migration has run or been recovered.

## Verification

- `bun test desktop/tests/state-format.test.ts`: 5 pass, 16 assertions, covering
  legacy initialization/concurrent starts, future format, interrupted migration,
  invalid/oversized contents and symlink refusal. Project fixture preserved.
- `bun run --cwd desktop typecheck`: passed.
- `bun run --cwd desktop package`: unsigned local arm64 package rebuilt.
- `bun run desktop/scripts/smoke-state-format.ts --packaged`: all three cases
  passed in the actual packaged main process. Each exited 1, preserved the marker,
  produced exactly the expected diagnostic and never opened project/task indexes.
  Evidence: `/tmp/har-state-gate-zfvIje/report.json` and committed JSON companion.
- `bun run --cwd desktop smoke:packaged --empty-start`: passed. Normal startup,
  SQLite conversations, approvals, streaming, cancellation, runtime crash/recovery,
  project isolation and renderer boundaries remain working in fixture projects.
  Evidence: `/tmp/har-electron-hud8oM/report`.
- `bun run desktop/scripts/smoke-layout.ts --packaged`: four cases passed at
  1120/720 pixels, credential settings open and closed. Evidence:
  `/tmp/har-layout-25mpzr/report.json`.

Concurrent formatting edits were preserved outside this change; only the semantic
main-process insertion is included in the commit. The HU34 DMG was not regenerated
and still contains the earlier build. No signing, notarization, push or publication.
HU35 remains open: trusted update configuration, native publisher verification,
active-work coordination, installation recovery, backup/migration and the full
user-facing update flow still need implementation and verification.
