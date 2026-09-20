# HU30 — recovery of interrupted active runs

In progress; the three acceptance criteria remain open.

An idle client adapter can now cancel a persisted active run after obtaining its
execution lease. A live lease returns BUSY; the UI explains that the user must wait,
refresh and cancel again. The adapter rechecks the run revision after acquisition,
requests cancellation of nonterminal descendants, finalizes only the parent it owns,
releases its lease and emits a durable cancellation checkpoint. Completed children
remain completed and independently running children retain their leases.

Recovery does not invoke the model or repeat a tool. Cancellation preserves stored
messages and journal evidence, does not undo file effects and does not claim that
an interrupted tool completed. Subsequent user input creates a new run using the
existing terminal-continuation handling for unresolved tool results.

The real Electron smoke kills its auxiliary process during the offline
wait-for-cancel fixture, reopens the same project and session, and verifies that an
immediate explicit cancellation fails while the old lease is valid. After waiting
31 seconds, another explicit UI cancellation succeeds. The run count is unchanged;
the same session then completes the rejection and approval scenarios. No automatic
mutation retry or forced lease takeover is used. The smoke timeout is 90 seconds
to accommodate the real 30-second lease expiry.

Validation: 656 tests passed, 0 failed, 3744 assertions across 87 files. Regression
tests cover live-owner refusal, stale revision, orphan cancellation, preservation
of messages/files, child ownership/status and continuation without tool replay.
Root, tooling and desktop typechecks, documentation and contract checks passed.
Installed CLI/SDK package smoke passed for version 1.0.0.

The unsigned macOS arm64 desktop package passed the full extended smoke with
activeCrashRecovered, liveLeaseCancellationRejected and orphanCancelledWithoutReplay.
Evidence: HAR_HU_30_ACTIVE_RECOVERY_PACKAGED_2026-09-20.json. This is an offline
fixture demonstration, not a live provider or real OCI-container certification.

Still required: forced interruption during a file effect and its reconciliation;
complete app close/reopen with pending approval; final diff inspection;
CLI/desktop session coherence; prioritized alpha issues and beta entry criteria.
No push, publication, signing or notarization is included in this increment.
