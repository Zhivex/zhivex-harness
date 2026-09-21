# HU35: durable combined application/state update job

`update-job.ts` binds the application swap receipt to the exact state transaction
ID and SHA-256 in a private durable journal. Its phases distinguish applying,
recovering, finishing and completed. Restarting an interrupted swap routes to
rollback; restarting recovery repeats both bundle and state restoration.

Before clearing the startup recovery gate, the job persists its chosen outcome
and finishing phase. If the process dies after clearing that gate but before
recording completion, retry verifies the existing outcome without restoring old
state over new user work. A failed finishing check retains that phase and never
silently chooses rollback. Missing or incompatible format markers and mismatched
state pointers are rejected; verification does not initialize missing markers.

Validation:

- `bun test desktop/tests/update-job.test.ts desktop/tests/state-transaction.test.ts desktop/tests/application-swap.test.ts desktop/tests/state-format.test.ts`
  passed: 24 tests, 109 assertions. Includes interrupted rename, interrupted
  recovery, lost completion acknowledgement, live-owner refusal, receipt mismatch,
  invalid durable phase/outcome and missing format marker.
- `bun run --cwd desktop typecheck` passed.
- `bun run desktop/scripts/smoke-backup.ts --job` passed using Electron 44.4.3 /
  Node 24.21.0 and the native lock helper. A worker mutates two fixture databases
  and metadata, records recovery, then is SIGKILLed. A new native process restores
  both databases, metadata and the previous fixture bundle, verifies them and
  clears the recovery gate. Report: `/tmp/har-update-job-report-KhZ8Dj/report.json`.
- `git diff --check` passed.

The native test uses small fixture bundles with an explicit version verifier;
it does not certify Developer ID/notarization. Production defaults retain the
native publisher verifier. Both databases and their restoration are real SQLite.
The fixture has no other state owners and supplies its own stopped-owner check;
it does not prove exclusion of arbitrary external CLI/SDK processes.

The executor must run under the native update-worker lock. `verifyState` is a
trusted host callback that must be read-only and verify the applicable state
contract. Current state support remains format 1; no future migration schema is
invented. Main still needs durable worker acknowledgement, full project/task
enumeration, owner exclusion, packaged worker/helper and UI integration. The
current app/DMG was not rebuilt. All HU35 acceptance criteria remain open;
production signing is deferred by user decision. No push or publication.
