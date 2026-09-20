# HU30 — pending-approval runtime recovery

In progress; the three acceptance criteria remain open.

The desktop now exposes “Reabrir proyecto” during disconnection. A newly launched
auxiliary process recovers dead-owner transport automatically, preserving sessions
and rejecting a live owner. Concurrent recoverers serialize through SQLite before
reading ownership and removing stale files; the owner lock is removed last.
Recovery index opening and its transaction use zero busy timeout to avoid blocking
the event loop while another recoverer awaits filesystem I/O. Other session-store
callers retain the prior 5000 ms default; the optional timeout accepts 0–5000 ms.

The packaged smoke kills the actual auxiliary process while a file approval is
pending, reopens via the UI, confirms a different PID, and reads the same undecided
run. It then rejects and subsequently approves through the normal workflow. The
report HAR_HU_30_RECOVERY_PACKAGED_2026-09-20.json records serviceCrashRecovered.

Validation: 655 tests passed, 0 failed, 3729 assertions across 87 files. Recovery
regression covers simultaneous attempts, bounded contention, durable session
preservation and refusal to remove a replacement live owner's credentials.
Root/desktop/tooling typechecks, docs and contract checks passed. The additive
openCliSessionStore option/signature was reviewed. The final unsigned macOS arm64
package passed the extended recovery smoke using offline model fixtures.

Still required: active-execution crash recovery/reconciliation, complete app close
and reopen with pending approval, final diff inspection, CLI/desktop session
coherence demonstration, prioritized alpha failures and beta entry criteria. This
increment is not HU30 closure, a release, signed/notarized delivery or publication.
