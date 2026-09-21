# HU35 — Production worker entry and receipt verification

The desktop build now emits `update-worker-entry.cjs`. Its four host arguments
identify userData, job, nonce and request digest. The entry validates the native
worker descriptor against the private staging lock, adopts the complete handoff,
acknowledges it, waits for recorded owners to exit and executes the durable job.
It uses the production native signature verifier; there is no fixture verifier or
renderer callback in this entry. Failure emits only a fixed recovery diagnostic.

Before clearing an active recovery gate, the worker verifies the entire receipt
inventory under exclusive leases. New receipts record each database's exact scope.
The reader rejects absent databases that gained files/sidecars, validates existing
databases without migrations, and compares desktop index/journal bytes with the
verified metadata backup. Extra, removed, changed and symlinked metadata is rejected.
The format marker is checked independently because the transaction changes it.
Older receipts remain restorable by the existing recovery component, but cannot
use the new live database verification without an explicit recorded scope.

If a durable finishing job lost its final acknowledgement after the gate cleared,
the production worker confirms current format and application identity without
comparing historical metadata or replaying restoration over newer user work.

Verification:

- TypeScript core/desktop and desktop build pass.
- Final full suite: 799 pass, 0 fail, 4518 assertions across 114 files
  (`/tmp/har-worker-entry-suite-final.log`).
- 26 targeted tests / 115 assertions pass, including exact inventory requirements,
  recorded scopes, absent sidecars, cleared-gate refusal and metadata changes.
- The production entry ran through the native helper in Electron 44.4.3 / Node
  24.21.0. It acknowledged the host, waited for its exit and rejected temporary
  unsigned bundles through the native verifier, preserving app/data with recovery
  armed: `/tmp/har-production-worker-report-OEjxSR/report.json`.
- The positive native component fixture executes receipt verification during job
  confirmation: `/tmp/har-transfer-report-IctTe9/report.json`.
- Missing-descriptor regression passes:
  `/tmp/har-transfer-rejection-report-4ZU7Qd/report.json`.

The first full-suite run exposed a fixture race: the launcher test could read an
empty `.started` file between creation and content write. The fixture now writes
its payload to `.starting` and renames it before readers observe readiness.

Reproduce after `bun run --cwd desktop build` with
`bun run desktop/scripts/smoke-backup.ts --transfer --production-worker`.
The positive component test still uses a fixture bundle verifier. The production
entry has only been verified for the native rejection path, not signed installation.
Compiled worker bytes are staged privately outside the application for that test.

Remaining: host/main and UI integration, authenticated feed/trust configuration,
staging the production worker from the installed app, nonparticipating SQLite
clients and final packaging/user-flow verification. Developer ID/notarization
remain deferred. No DMG regeneration, push or publication; HU35 stays open.
