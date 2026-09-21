# HU35: detached worker lifetime and mutual exclusion

The host launch primitive now starts a detached native process with a private,
descriptor-bound lock and an allowlisted environment. A small Swift helper takes
`flock` on inherited fd 3, clears close-on-exec, and becomes Electron via `execv`.
The helper and worker have the same PID. The lock inode is kept permanently;
existence alone never implies a live owner and no stale PID file is deleted.

An initial experiment with macOS `lockf` was rejected: killing its supervisor
allowed a contender while the original worker remained alive. The final helper
avoids that extra supervisor and keeps the lock with the worker itself.

Validation on this Mac:

- `bun test desktop/tests/update-worker-launcher.test.ts`: 4 pass, 13 assertions.
- The worker runs under the actual installed Electron executable in Node mode.
  Its separate Bun launcher exits before the worker finishes. A second native
  worker cannot enter; after normal exit it can acquire the same lock inode.
- SIGKILL of the worker releases the kernel lock and permits a subsequent worker.
- Helper PID equals Electron worker PID; a contender is excluded while it lives.
- Public staging and a symlink lock are rejected, preserving the target bytes.
- The fixture's secret environment sentinel does not reach the worker.
- `bun run --cwd desktop typecheck` passes.
- `bun run desktop/scripts/build-update-worker-lock.ts` builds the helper with
  minimum target arm64 macOS 13.0. This is not an OS compatibility certification.

The worker must retain fd 3 and must not replace/unlink the lock or staging
directory. Returned PID means spawned, not ready: main must wait for a durable
worker acknowledgement before quitting. The helper/executable/worker paths are
trusted host inputs, never renderer selections. This lock excludes other update
workers only; it does not prove that all external SQLite owners are stopped.

Still required: a bundled update job with durable acknowledgement, binding of the
state receipt to the app swap, interrupted-job recovery, all-project enumeration
and owner checks, coordinator/main/UI wiring, and inclusion of this helper in
packaging and the publisher-signature policy. The current app/DMG was not rebuilt
and does not expose an updater. Production signing remains deferred by the user.
No acceptance criterion is closed by this component increment. No push.
