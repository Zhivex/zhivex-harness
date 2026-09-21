# HU35 — Receipt-bound state handoff

The worker acknowledgement now requires adoption of every database lease recorded
in the backup receipt, including databases absent at backup time. The ordered
descriptor map and owner PID list are covered by the exact request SHA-256 passed
by the host. Missing, duplicated, shared or mismatched access is rejected before
acknowledgement. Adoption retains the native helper's exclusive locks; JavaScript
validates descriptor/path identity, not the kernel lock mode independently.

The native transfer fixture now exercises one continuous path: exclusive backup,
armed recovery, persisted application/state job, bound handoff, worker adoption,
acknowledgement, actual host exit and durable job completion. It checks snapshot
records, exclusion before and after host exit, installed bundle version, and data
preservation after killing the worker. The negative variant deliberately omits
the inherited state descriptors: acknowledgement fails, the previous app and data
remain intact, and the recovery gate remains armed.

Verification:

- `bun test desktop/tests/update-handoff.test.ts desktop/tests/update-job.test.ts desktop/tests/state-transaction.test.ts`: 19 pass, 84 assertions.
- Core and desktop TypeScript checks pass.
- Full suite: 796 pass, 0 fail, 4507 assertions across 114 files; log at `/tmp/har-handoff-bound-suite.log`.
- `bun run desktop/scripts/smoke-backup.ts --transfer`: Electron 44.4.3 / Node 24.21.0, all checks pass.
- `bun run desktop/scripts/smoke-backup.ts --transfer --missing-state-fd`: rejection and preservation checks pass.
- Empty-inventory native handoff regression also passes.

Native results are preserved in the adjacent JSON report. Original evidence:
`/tmp/har-transfer-report-rNUpu9/report.json`,
`/tmp/har-transfer-rejection-report-jaTP3m/report.json` and
`/tmp/har-handoff-report-mxvl5x/report.json`.

This remains component integration using a fixture bundle verifier. It does not
certify a signed/notarized release or a production UI update. Main/UI, the
production worker entry and treatment of old/direct SQLite clients that do not
participate in the access protocol remain outstanding. No DMG regeneration,
push or publication. HU35 acceptance criteria remain open.
