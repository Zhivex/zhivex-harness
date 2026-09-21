# HU35: cooperative macOS SQLite access exclusion

Every current core SQLite connection on macOS now holds a shared kernel file lock
for its lifetime. An updater can acquire exclusive access only after all those
connections close. While exclusive access is held, opening another core connection
fails before SQLite opens. Normal connection shutdown releases its own lease;
failed construction releases it too. In-memory databases and other OSes retain
their existing behavior; this update protocol targets macOS desktop.

The lock is a permanent private zero-byte `.DATABASE_NAME.access-lock` sibling.
Darwin `O_SHLOCK` (0x10) and `O_EXLOCK` (0x20), verified in the installed SDK's
`sys/fcntl.h`, make acquisition atomic with open. Node forwards these native flags
although it does not export their symbolic constants. Acquisition is nonblocking;
no process is cancelled or killed by the implementation.

The existing exclusive owner can lend a process-local lease to its verifier
connections. Forged, wrong-database or closed leases are refused. Borrowers keep
the kernel lock until SQLite closes even when the owner requests release early.
Every statement invocation checks that the held lock inode is still the current
one, including statements prepared before an attempted lock-file replacement.

Verification:

- Five targeted access tests / 14 assertions passed.
- Full suite outside the socket-restricted sandbox: 789 pass, 0 fail, 4483
  assertions, 114 files. Log `/tmp/har-access-full-suite-approved.log`.
- The first sandboxed run had 781 passes and eight EPERM Unix-socket failures;
  these passed in the authorized rerun. They were not hidden or skipped.
- Core and desktop TypeScript checks and `git diff --check` passed.
- `bun run desktop/scripts/smoke-backup.ts --access` passed with Node 24.21.0 /
  Electron 44.4.3: a live core connection excluded an exclusive peer; an exclusive
  peer excluded new core connections; SIGKILL of that fixture peer released the
  kernel lock and preserved database contents. Native report:
  `/tmp/har-access-report-MnlNQb/report.json`.

This is cooperative exclusion for clients using the updated core adapter. Older
binaries and arbitrary direct SQLite libraries do not participate. It is not a
claim of universal filesystem exclusion. The updater must still acquire/transfer
exclusive leases across main exit, preserve their inodes during restore and
handle nonparticipating owners before state replacement. Worker/main/UI integration
remains pending. The installed app/DMG was not rebuilt for this increment; its
previous installer evidence must not be taken as evidence for this new gate.
Production signing is deferred; no push, publication or HU35 criterion closure.
