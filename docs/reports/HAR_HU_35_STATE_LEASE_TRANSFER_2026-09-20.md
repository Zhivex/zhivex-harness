# HU35: exclusive backup and inherited state leases

The host can now acquire the complete registered state inventory exclusively
before snapshotting. Acquisition is nonblocking and releases earlier leases if a
later source is busy. The full backup reader borrows the source lease; private
snapshot copies use their own ordinary connection locks. Sources remain exclusively
locked after preparation returns.

The native launcher accepts only live exclusive host leases with no outstanding
borrowed connections. It snapshots the transfer list and revalidates descriptors
immediately before spawn, rejecting a lease released during asynchronous setup.
It passes fd 4 onward to the native helper; fd 3 still serializes update workers.
The helper reasserts LOCK_EX and preserves all descriptors across exec without
unlocking. Worker-only adoption verifies the inherited descriptor against the
recorded database's lock inode. Duplicate adoption and wrong/closed leases fail.

Verification:

- Full suite: 794 pass, 0 fail, 4500 assertions, 114 files.
  `/tmp/har-state-transfer-full-suite.log` (authorized local-socket execution).
- Core/desktop TypeScript and diff checks pass.
- Native WAL-backed state: `bun run desktop/scripts/smoke-backup.ts --transfer`.
  A fixture host prepares an exclusive real Harness SQLite backup and launches
  Electron with the inherited lease. The test reads the copied session and an
  additional table from the snapshot, checks client exclusion before host exit,
  lets the host close its descriptor and exit, then confirms exclusion again.
  The worker uses its inherited lease. SIGKILL of that worker releases the kernel
  lock and the original records remain intact.
  `/tmp/har-transfer-report-xCEKlw/report.json`.
- Unit cases cover absent databases, partial acquisition cleanup, live-owner
  preservation, shared/duplicate lease rejection and release during launch.

The lock mode is established by the trusted native helper before worker adoption;
JavaScript inode validation alone is not a lock-mode proof. The production worker
must bind its ordered path/descriptor map to the persisted state receipt before
acknowledging. That integration, main/UI and handling nonparticipating old/direct
SQLite clients remain outstanding. This protocol covers updated core clients;
it is not universal filesystem exclusion. The app/DMG was not regenerated for
this increment, and production signing remains deferred. No push or HU35 closure.
