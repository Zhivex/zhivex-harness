# HU35: durable worker acknowledgement and host exit

Each handoff persists a unique nonce, immutable job-identity digest and known owner
PIDs, including main automatically. Under the native worker lock, the worker
validates that identity and atomically publishes its own PID acknowledgement.
Main waits for that exact spawned PID to acknowledge the matching attempt; spawn
alone, timeouts, changed job receipts and stale acknowledgements do not permit exit.

The worker waits for every recorded owner to exit before executing the update and
rechecks them at destructive boundaries. Unknown PID status fails closed; PID
reuse conservatively blocks. No termination or cancellation signal is sent by the
production handoff implementation. The job identity excludes mutable phase/outcome
so validation remains valid throughout installation/recovery.

Validation:

- 12 tests / 48 assertions across handoff and durable update-job tests passed.
- Desktop TypeScript and `git diff --check` passed.
- `bun run desktop/scripts/smoke-backup.ts --handoff` passed under Electron 44.4.3 /
  Node 24.21.0. A separate native fixture host launched the lock-protected worker,
  waited for its durable acknowledgement and remained alive. The outer fixture
  confirmed both PIDs were alive and the old bundle had not moved, then allowed
  the host to exit normally. The same worker PID completed the durable install.
  Report: `/tmp/har-handoff-report-81u41z/report.json`.

The fixture uses small bundles and an explicit version verifier, not production
signature certification. The state is an empty fixture profile. Previously recorded
SQLite/crash recovery checks remain separate evidence. This is a protocol test,
not an end-to-end main/UI upgrade.

The PID list covers known host/runtime owners only; it is not a proof that arbitrary
CLI/SDK processes cannot access SQLite. External-owner exclusion, main/UI wiring,
and packaging/signature policy for helper/worker remain required. Production signing
is deferred. No app/DMG rebuild, push, publication or HU35 acceptance closure.
