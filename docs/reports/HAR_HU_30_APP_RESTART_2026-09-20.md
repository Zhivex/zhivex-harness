# HU30 — application restart and shared CLI session

The interruption and CLI/coherence acceptance criteria are verified locally;
the complete final-diff criterion remains open. This is not HU30 closure or beta.

The application now handles renderer process loss with a native reload/close
dialog. Reload restores persisted state without submitting a prompt. A host-only
fixture selects reload through this production handler. Native dialog appearance
is not automated; Electron on this Mac reports forced renderer loss as `killed`.

The restart smoke launches three separate main processes and three separate
utility processes against the same private user data and repository:

1. Create a session and pending file approval. Kill the renderer and recover the
   identical run/approval. Close the native window before any decision.
2. Reopen from the persisted recent-project list. Verify the same session, run,
   revision, approvals and unchanged file. Reject the former main process's review
   receipt. Review again and explicitly approve the complete before/after content.
3. Reopen from recent projects once more and inspect the one persisted applied
   decision. Verify exact file bytes and unchanged run count. The outer driver
   checks that main and utility PIDs from each prior phase no longer exist.

The actual built root CLI connects to the desktop service using `--service`,
executed under Electron's embedded Node runtime. It compares full session documents
at pending approval and completion, renames the session and verifies that the
desktop displays that title. This is built-CLI evidence, not a separately installed
CLI certification. The credential path stays on the trusted fixture host; neither
token nor credential path is sent to renderer IPC or included in the report.

Evidence: HAR_HU_30_APP_RESTART_PACKAGED_2026-09-20.json, unsigned macOS arm64,
three process lifetimes and the same session/run identifiers. The complete
interruption matrix, prioritized alpha issues and beta entry conditions are in
HAR_DESKTOP_ALPHA_BETA_ENTRY_2026-09-20.md. Previous packaged transport/runtime
crash evidence remains in the HU30 recovery and active-recovery reports.

Validation: 656 tests, 0 failures, 3744 assertions across 87 files; root, tooling
and desktop typechecks; documentation and contract checks; packaged restart smoke.
Offline provider fixtures only. No signing, notarization, push or publication.

Remaining implementation/verification: durable complete final diff, forced failure
at the file-effect/journal boundary, and an explicit close choice for unbounded
active work. HU31–35 retain their separate acceptance requirements.
