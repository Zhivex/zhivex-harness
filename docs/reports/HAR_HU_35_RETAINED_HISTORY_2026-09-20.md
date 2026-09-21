# HU35: retained state after worktree removal

The update inventory now includes managed task state even when its checkout has
been deleted. An explicit `workspaceAbsent` receipt flag retains the canonical
workspace identity; no placeholder directory is created. Restore validates the
recorded path and its existing ancestors before touching state.

The internal archived-state reader reuses logical record validation with the exact
workspace/scope binding, but reads existing SQLite without opening session stores,
creating schemas or migrating data. Incompatible session schemas fail closed. The
normal public backup/import path retains its existing canonical-workspace rules;
the archive reader is not exported from the package entrypoint.

The desktop backup still captures the whole SQLite database, checks idleness in
all scopes, checks integrity and hashes the complete copy. The archive logical
reader runs on that copy. Existing state receipts without the new optional field
remain readable. This resolves the retained-history limitation recorded in the
preceding inventory report.

Verification:

- 32 tests / 146 assertions passed across normal core backup/import, archived
  reader, desktop inventory, state transactions and update jobs.
- Desktop TypeScript and `git diff --check` passed.
- Native Electron 44.4.3 / Node 24.21.0: `bun run desktop/scripts/smoke-backup.ts --job`.
  Two real SQLite databases were backed up, one with its checkout removed. A
  native worker was SIGKILLed after recording migration failure. A new process
  restored both databases, metadata and the fixture app, and confirmed that the
  absent checkout stayed absent. Report: `/tmp/har-update-job-report-tVDPK2/report.json`.
- Tests also preserve exact workspace/scope bindings and source bytes, reject a
  replaced canonical ancestor, and leave an incompatible schema unchanged.

The native application verifier in this smoke is an explicit fixture, not a
signed/notarized release certification. Remaining HU35 work: main/UI, durable
worker acknowledgement, exclusion of external state owners and helper/worker
packaging. Signing remains deferred by user decision. The app/DMG was not rebuilt;
no push, publication or acceptance checkbox closure.
