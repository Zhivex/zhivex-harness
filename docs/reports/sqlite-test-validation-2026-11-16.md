# SQLite test environment correction — 2026-11-16

Follow-up to the five failures recorded in the [dependency validation report](dependency-update-validation-2026-11-16.md).

## Cause and correction

On this macOS ARM64 host, Bun 1.4.4's `node:sqlite` cannot query a closed
WAL-mode database opened with `readOnly: true` after its sidecars disappear.
A minimal exec-only writer followed by a read-only reader reproduces error 14.
This matches [Bun issue #45171](https://github.com/oven-sh/bun/issues/45171).
Selecting Homebrew SQLite 3.54.0 with `Database.setCustomSQLite()` fixes the
same query through the unchanged `node:sqlite` interface.

The macOS test preload now selects standard SQLite before databases open.
It supports both Homebrew prefixes and an explicit `HARNESS_TEST_SQLITE_LIBRARY`
path, and fails with installation guidance if the library is unavailable.
CLI contract subprocesses load the same configuration and inherit an explicit
library override. Other operating systems do not select a custom library.

This corrects the contributor test environment, not a production persistence
defect. Published Node and Electron code is unchanged. No mocks, skips, writable
fallbacks, immutable database flags, or journal-mode conversions were added.

## Verification

- Complete `bun run test` suite: 2,744 passed, one existing unsupported-platform
  skip, zero failed; 18,353 assertions across 367 files in 226.29 seconds.
- Targeted SQLite, sessions, state import, CLI and desktop backup tests: 67 passed,
  zero failed. All five previously failing cases pass with their assertions intact.
- New regressions cover both a settled WAL database without sidecars and an open
  writer with uncheckpointed WAL data. Readers see committed data, reject writes,
  and leave the main database bytes unchanged.
- The same settled/live WAL checks also passed independently under Node 24.11.0.
- Tooling typecheck passed.
- Separate CLI suite: 171 passed, zero failed.

The earlier packaged-app validation remains historical evidence; this change
does not alter or rebuild the distributed application.
