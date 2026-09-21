# HU35 — Worker live-state verification

`verifyDesktopDatabaseState` checks a live database under the worker's inherited
exclusive lease. It validates the recorded workspace, private directory/file,
size, SQLite integrity, idle status across all scopes, and core export schemas
and records. It uses the internal archive reader even when the checkout exists,
so verification never invokes schema migration, session creation or checkpointing.
The archive reader now accepts an internal borrowed lease and closes the database
even if transaction initialization fails. Public backup exports are unchanged.

The native transfer fixture calls the verifier before and during durable job
confirmation. It also writes an incompatible schema version, verifies rejection,
checks that the invalid version remains unchanged, and restores the fixture value
before continuing. Successful and rejected verification preserve main database
and nonempty WAL bytes. SQLite can create empty WAL/SHM bookkeeping while opening
a read-only connection; this is not a claim of zero filesystem writes.

Validation:

- 21 relevant tests pass, 88 assertions: archived backup, public backup, database
  backup and access lease tests.
- Core and desktop TypeScript checks pass.
- Native Electron 44.4.3 / Node 24.21.0 transfer, verification, incompatible-schema
  rejection, durable job completion and post-crash data preservation pass.
  Evidence: `/tmp/har-transfer-report-MxdLjU/report.json`, copied beside this report.

An initial fixture incorrectly compared export checksums across runs. Those
checksums include the export timestamp, so they are not a stable data fingerprint.
The verifier validates readability/compatibility and idle state; it does not claim
equality with a prior export or semantic validation of all desktop activity tables.
The existing native fixture separately checks retained session and custom records.

This supplies the production database verifier, but the worker entry, full receipt
and metadata verification, main/UI integration and handling of nonparticipating
SQLite clients remain unfinished. Bundle signature verification in this native
fixture is simulated. HU35 remains open; signature/notarization remain deferred.
No package/DMG regeneration, push or publication.
