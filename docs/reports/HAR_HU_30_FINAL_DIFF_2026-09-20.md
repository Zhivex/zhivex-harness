# HU30 — durable final diff

The main alpha journey now includes final diff inspection, including the verified
OCI fixture flow. HU30 remains in progress for the open effect-boundary crash P1.

Before executing an approved file decision, the client captures the complete
protected preview and commits it with decision intent. The archive is bounded to
2 MiB per run and 512 entries; the existing preview limit is 256 KiB per projection.
Rejected decisions do not read or archive additional file content. Metadata keys are
separate from the existing ledger so old runs remain readable without migration.

`run.get` accepts optional `includeDiff: true`. Ordinary reads and mutation responses
keep the lightweight history. The expanded view requires an applied journal receipt,
matching approval identity/digest, proposal, exact unique file set, before/after
digests and matching hashes of the saved text. Reviewed OCI proposals are bound
separately from the verified environment patch identity. Unknown, failed, rejected
and merely approved operations do not expose a final applied diff. Missing,
malformed or mismatched archives show an explicit unavailable state.

The desktop history offers “Ver cambio aplicado” with complete before/after text,
captured modes where available, and an explicit redaction notice when host redaction
changes displayed content. React renders literal text, including repository HTML-like
strings. This is a historical decision view; later repository edits cannot enter it.

Packaged evidence:

- HAR_HU_30_FINAL_DIFF_RESTART_PACKAGED_2026-09-20.json: three app lifetimes, persisted
  decision and final diff, exact CRLF preimage/destination, later unrelated edit
  excluded without rewriting the current file, literal HTML-like text.
- HAR_HU_30_FINAL_DIFF_OCI_PACKAGED_2026-09-20.json: review, explicit approval,
  verification and import of the exact patch, followed by its complete final diff.
  The runtime is an offline OCI adapter fixture, not real Docker certification.

Validation: 667 tests passed, 0 failed, 3790 assertions in 89 files; root/tooling/
desktop typechecks and contract checks passed. Tests cover Unicode/BOM/CRLF,
create/delete, absent and malformed archives, mismatched receipt identities/paths/
content, non-applied outcomes, bounded archive growth, redaction and newly opened
Harness instances after subsequent file changes. Unsigned macOS arm64 package.

No live provider, signing, notarization, push or artifact publication is claimed.
The next required fault demonstration interrupts execution between file effect and
journal completion and verifies reconciliation without replay.
