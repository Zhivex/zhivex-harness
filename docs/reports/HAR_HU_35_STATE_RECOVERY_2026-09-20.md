# HU35: persistent state recovery transaction

`state-transaction.ts` combines database and desktop-metadata backups into a
private on-disk receipt. It records workspace/state bindings, backup hashes and
explicitly absent databases. Limits are 600 supplied databases, 512 MiB of database
copies and a 2 MiB receipt, in addition to the component limits. The caller must
enumerate every relevant project/task and hold update admission closed throughout.
The format gate now checks recovery intent before any state initialization.

Arming publishes `update-recovery/active.json`, containing the transaction ID and
receipt SHA-256, before changing the format marker to migrating. The active file
alone blocks startup, covering a crash before the second write or after resetting
the marker. Private atomic publication and directory syncs preserve the receipt.
An interrupted temporary hard link is readable for journal recovery; snapshot
and metadata source validation retain their existing checks.

Restoration loads its receipt from disk, rechecks workspace bindings and verifies
every backup before touching destinations. It requires a host callback to confirm
that all state owners have stopped, then repeats that check before each target.
Old database/WAL/SHM files are moved into a private per-state quarantine before
the verified database is published. Metadata originals and files introduced by
an interrupted migration are preserved separately. Absent originals return to
absence. A failure leaves recovery intent active; retry repeats restoration without
requiring the original in-memory transaction object. No quarantined user bytes are
deleted. A final confirmation callback must verify application-binary recovery as
well as state before clearing intent and allowing startup.

## Verification

`bun test desktop/tests/state-transaction.test.ts desktop/tests/state-format.test.ts`:
**10 pass, 0 fail, 45 assertions**. Desktop TypeScript passed.

Tests restore two SQLite databases and their visual history after an injected
failure following the first write; restore metadata and prior absence; preserve
new database/orphan WAL/SHM bytes; reject corrupted copies, changed receipts and
unconfirmed owners before writing; and keep startup blocked until final approval
of recovery. The Bun fixture holds writable SQLite connections during capture,
matching paused runtime owners. Bun's first read-only open of a closed WAL fixture
returned SQLITE_CANTOPEN during investigation; production behavior was separately
verified with Electron's native Node/SQLite implementation, without such handles.

`bun run desktop/scripts/smoke-backup.ts --recovery` passed on **Electron 44.4.3 /
Node 24.21.0**: two initially closed databases, interrupted restoration, retry from
disk, readonly verification and release of the state gate. Evidence:
`/tmp/har-state-recovery-report-HkMtt0/report.json` and the committed JSON companion.

The unsigned app package was rebuilt. Packaged state-gate smoke passed all four
cases, including intent present with a ready format marker, preserving markers and
never opening project/task registries (`/tmp/har-state-gate-AGtX9j/report.json`).
Packaged normal-flow smoke also passed (`/tmp/har-electron-NSPiQx/report`), including
fresh startup, conversations, approvals, cancellation and crash recovery. All four
layout checks passed (`/tmp/har-layout-bM2CyL/report.json`).

## Outstanding integration

This implements actual state-file restoration on isolated fixtures, not a signed
application update. The transaction is not yet connected to the update coordinator
or UI. Its owner checks and final binary-verification callback must be implemented
by that integration; an empty fixture callback is not production proof that all
owners have stopped or that a binary was restored. Native publisher verification,
installation/binary rollback, project/task enumeration and the complete user flow
remain open. The DMG was not regenerated. No push, signing, notarization or
publication. All HU35 acceptance criteria remain open.
