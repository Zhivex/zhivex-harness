# Application migration and recovery

Electron is maintained in [zhivex-app](https://github.com/Zhivex/zhivex-app). Harness retains `packages/core/src`, the shared application domain, the terminal product in `packages/cli`, and the recovery tools. The root package still publishes `@zhivex-ai/harness` with the same exports and binaries. Core remains a private workspace with matching version and engines; `bun run workspace:check` validates this invariant. The root lockfile covers core and CLI only.

## State and credential continuity

Repository extraction does not relocate personal state. Keep `~/.zhx-app`, external Code state directories, project/worktree paths, IDs, scopes, provider bindings, pending decisions and credential references. Keep the Electron package identity, bundle ID and effective userData path. Do not merge profiles or convert unknown Tauri data. Credentials remain in their original Keychain services and accounts.

The cutover rehearsal verified real credential access from both packaged executables, equivalent profile/session projections, and unchanged conversation/run/activity tables. Backups and detailed personal-profile evidence are stored privately, not in Git. No model request or credential write was required. See [extraction status](https://github.com/Zhivex/zhivex-harness/blob/main/docs/extraction/STATUS.md).

## Offline backup and rollback without Keychain export

Run `bun run migration:application` from a Harness checkout. It requires explicit roots and never discovers or exports credentials. It snapshots bytes; it is not an unknown-schema converter.

1. Stop Electron, coordinators, CLI and every other writer sharing the state. Inventory all personal state roots, external Code state and Electron metadata needed for recovery. Do not select whole repositories, worktrees or the home directory.
2. Select canonical absolute directories, private to the same user, without overlap or symlinks. The backup must be outside every source. Files must be private, regular and single-linked. Limits are 32 roots, 10,000 files/directories, 128 MiB per file and 512 MiB total. Nonempty WAL/journal files are rejected; checkpoint cleanly and never delete WAL files manually.
3. Run `bun run migration:application backup /absolute/backup /absolute/personal-state /absolute/code-state`. The tool holds coordinator and SQLite exclusion locks and rejects a live legacy owner. Credentials are not read or copied; opaque references remain in state.
4. Keep `manifest.json`, `journal.json` and `objects/` together. Verify sizes and SHA-256 values. After interruption, retry with the same backup and roots; a changed source is not silently accepted.
5. To restore, run `inspect-rollback` with the same arguments, inspect current state and pass the returned `currentSha256` to `rollback ... --expected-current=HASH`. Verification precedes writes. Newer content is preserved in `before-rollback/` and `before-rollback-manifest.json`; newly created empty directories may remain.
6. Resume interrupted restoration with the same backup and approved hash. The journal tracks completed writes. A completed restore cannot overwrite later work using stale consent.

`.zhivex-migration.json` blocks admission during an incomplete operation. Do not delete markers or lock files manually. An incomplete copy can be cancelled through `abort ... --expected-current=HASH` after inspection; a restore already in progress must finish. Use a fresh destination for a later backup.

SQLite may create empty WAL/shared-memory sidecars when opening an otherwise settled legacy database. The real cutover rehearsal kept read-only SQLite handles open around the unchanged backup routine to stabilize those operational files; no user records or journal mode were changed. A source-change error must be diagnosed before proceeding, never bypassed by weakening verification.

Cooperative exclusion is supported on macOS only. Older clients and arbitrary processes that ignore the protocol must stay stopped. The tool cannot certify that the operator inventoried every external root.

## Distribution limits

Published core migration fixtures remain 0.10.0 and 0.11.1; `bun run migration:check` checks them against the current motor. The repository split changes neither protocol nor persisted-state versions.

This extraction does not certify unknown Tauri formats, production Developer ID signing, notarization or signed updates. The alpha app remains unsigned/unnotarized, and the production update feed stays disabled. Fixture rollback success is distinct from a signed production install/update/rollback demonstration.
