# Dependency update validation — 2026-11-16

Updated the remaining provider adapters, Google authentication library, ACP/MCP SDKs and Node types after the Qwen4 Max commit. Core remains pinned to 1.40.1.

The proposed `typescript-compiler-api` upgrade to 7.0.2 failed tooling typechecking because that distribution does not expose the JavaScript compiler API used by architecture checks and public API signature tooling. Keep the alias at `npm:typescript@6.0.3`; the main compiler remains TypeScript 7.0.2.

Smoke diagnostics now name ACP 2.7.0 and MCP 2.4.0. Electron smoke selectors were updated for the existing response-cancellation status, connection label and command-palette placeholder; no product behavior was changed.

## Results

- Core, tooling, CLI and Electron typechecks passed; architecture and model catalog checks passed.
- Core and CLI builds and the macOS ARM64 Electron package succeeded.
- CLI: 171 tests passed, plus the interactive PTY smoke covering edits, approvals, recovery and exit.
- Core/Electron suite: 2,737 passed, 1 skipped, 5 failed. All five SQLite failures reproduced with the previous dependency snapshot at `b2791da`; this is not a claim of a fully green suite.
- Official MCP SDK loopback interoperability passed with 2.4.0.
- Real Electron/CLI integration passed: shared sessions, reviewed edits, cancellation, reconnect, restart, drafts and hidden-window operation.
- Packaged Electron autonomous smoke passed: onboarding, streaming, native status-menu behavior, coordinated quit, restart and worker recovery.

## Existing limits

The five baseline failures concern session metadata inspection, an orphan import lease, doctor on a session-only database, and two desktop backup scenarios. They report SQLite open/backup errors with both dependency sets.

Follow-up: the [SQLite test environment correction](sqlite-test-validation-2026-11-16.md)
resolves these five failures; the complete rerun passed with 2,744 passing tests,
one existing skip and zero failures. The results above preserve the original run.

The separate CLI onboarding smoke fails with both dependency sets because it expects a plain prompt while the current terminal emits ANSI cursor controls. The general interactive PTY smoke passes. Strict workspace inventory fails in the developer checkout because ignored legacy package directories remain, and passes in a clean source snapshot; no local directories were deleted.

Follow-up: the [CLI onboarding smoke correction](cli-onboarding-smoke-validation-2026-11-16.md)
resolves prompt matching and stale UI assertions. Both the onboarding and general
PTY smoke scripts now pass.

[Structured validation evidence](evidence/dependency-update-validation-2026-11-16.json) records the successful integration and packaged-app reports and the baseline comparison. The smoke provider was a local fixture; this update does not certify every provider against its live service.
