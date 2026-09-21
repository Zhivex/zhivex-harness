# HU35: registered state inventory for update preparation

The host preparation adapter now snapshots the project/task registries and
enumerates unopened projects, all task statuses, and task source projects that
have fallen out of the recent-project list. A managed checkout appearing in the
project registry uses its task state directory, not the normal project default.
Paths, task/project identities and duplicate records are validated before backup.
No Git commands, registry reconciliation, runtime startup or credential reads occur.

`prepareDesktopUpdateState` passes this inventory into the existing complete state
transaction. Host mutation admission must remain closed throughout preparation.
The adapter is ready for main integration but is not yet called by main/UI.

Validation: `bun test desktop/tests/update-inventory.test.ts` passes six tests /
21 assertions; desktop TypeScript and `git diff --check` pass. The integration case
creates real source/task SQLite databases with separate conversations, supplies
only the task checkout as a recent project, prepares the backup, and reads both
conversations from the resulting independent snapshots.

A missing checkout is explicitly recorded only if its state directory is also
absent. Retained state for a missing checkout is never silently omitted: preparation
currently rejects it with `UPDATE_STATE_WORKSPACE_UNAVAILABLE`. Task removal keeps
its history but removes the checkout; the current core backup binding requires a
real workspace. Supporting backup/restoration of this retained history remains
required before the complete update flow can be accepted. No placeholder checkout
is created and no history is removed as a workaround.

Also still pending: main/UI, durable worker acknowledgement, external state-owner
exclusion, helper/worker packaging and deferred production signing. The inventory
is bounded by the existing 600-state transaction limit; exceeding it fails closed.
No app or DMG rebuild, push, publication or HU35 criterion closure in this increment.
