# HU35: full database and desktop metadata backup components

`database-backup.ts` captures the entire SQLite database, including visual event
and snapshot tables, using parameterized `VACUUM INTO`. SQLite documents this as
a consistent snapshot including committed content, without changing the source:
[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause).
The copy is checked for integrity, nonterminal runs/session runs/tool journals and
active leases across all scopes. Core logical-backup validation is also reused on
the copy, preserving existing binding/schema checks without migrating the source.
The snapshot is checkpointed, synced and hashed after validation.

Source directories/files are checked for private ownership, symlinks and size.
The logical database size is bounded to 128 MiB before copying, and the final
descriptor-bound read is bounded to the same limit. `data_version` changes during
capture reject the copy. This does not lock every external writer for a future
installation: the host must maintain exclusive update admission and revalidate
state before replacement. Paths/receipts are trusted host inputs, not renderer or
download-manifest inputs. SQLite opens the validated source by path; the containing
state directory must remain controlled throughout the operation.

`metadata-backup.ts` preserves the project/task indexes, format marker, and all
Git commit/push/pull-request journals. Only those paths are enumerated. Repository
contents, task checkouts, Chromium profile/cookies and credentials are excluded.
Missing indexes are explicitly represented for eventual rollback. File reads use
the existing descriptor-bound no-follow helper, private ownership/permissions and
limits of 1 MiB/file, 16 MiB total and 4096 entries. Copies and directory links are
synced. Recovery readers verify every SHA-256/size/path before returning any bytes.
Corruption, unsafe paths and capture failures produce fixed diagnostic codes and
discard only the current partial backup directory.

## Verification

`bun test desktop/tests/database-backup.test.ts desktop/tests/metadata-backup.test.ts`:
**7 pass, 0 fail, 34 assertions**. Desktop TypeScript check passed.

Tests cover WAL content with an open source connection; unchanged original bytes;
conversation/visual event/visual snapshot retention; additional table/index
preservation; foreign-scope active work, orphan leases and running tool journals;
tampering and unsafe permissions; metadata/index/journal byte preservation;
explicit absent files; duplicate/path-traversal/symlink rejection; and cleanup.

`bun run desktop/scripts/smoke-backup.ts` passed with **Electron 44.4.3 / Node
24.21.0** in run-as-node mode, using freshly bundled production modules and only
temporary fixtures. The native SQLite implementation retained WAL content,
conversation and visual history, left original bytes unchanged, and verified the
metadata copy. Evidence: `/tmp/har-native-backup-nCGRrm/report.json`, copied to the
JSON companion report. This is a native-runtime component check, not a packaged
user-interface recovery flow or an installed-app update.

## Remaining work

These components are not yet wired to the update coordinator/main/UI. The receipt
must still be durably stored and validated as part of one cross-project backup;
recovery must safely restore all databases and metadata under the migration marker.
No original user state is restored or replaced by these tests. Native publisher
verification and the actual install/migrate/rollback flow remain open. All HU35
criteria remain unchecked. No package/DMG rebuild, push, signing or publication.
