# HU30 — closing during active work

The alpha P1 for hidden, indefinitely waiting shutdown is resolved locally.
HU30 remains open for the final diff and effect-boundary reconciliation.

Both native window close and application quit now keep the window alive while
coordinating all opened runtimes. The service exposes trusted-host pause/resume and
active-cancellation controls, not HTTP or renderer commands. Pausing atomically
blocks new mutations after request parsing; reads and explicit cancellation remain
available. This prevents a pre-existing partial request from admitting work after
the shutdown decision. The closing-state check is also repeated after body parsing.

If any operation is active, a native dialog offers returning to the app or cancelling
work before exit. Returning restores admission without cancelling. Cancelling sends
one cancellation request per host and checks for completion. If the cancellation
does not finish or host state is unknown, admission is restored where possible and
the window stays open. No forced process exit or automatic tool retry occurs.
Cancellation does not undo previously applied effects. Pending approvals are kept
when there is no active invocation; ordinary pending-approval restart still passes.

The packaged test starts an offline run that waits for cancellation, requests native
window close and chooses stay, verifying the original run is still running. It then
requests application quit and chooses cancellation. The outer driver verifies that
both main and utility processes terminate. A fresh app process restores the same
cancelled run, exact run count, unchanged file and matching CLI session. Choices are
injected on the trusted host; native dialog appearance is not automated.

Evidence: HAR_HU_30_ACTIVE_CLOSE_PACKAGED_2026-09-20.json. The existing three-phase
pending-approval, renderer-crash and CLI-coherence smoke also passed against this
package: HAR_HU_30_CLOSE_PENDING_REGRESSION_2026-09-20.json.

Validation: 662 tests passed, 0 failed, 3764 assertions across 88 files. Targeted
tests cover multiple hosts, staying, cancellation exactly once, unresponsive
cancellation, unavailable host, pause/read/resume and partial-body admission races.
Root/tooling/desktop typechecks and contract checks passed. Package scope is unsigned
macOS arm64 with offline model fixtures; no live OCI/provider or notarization claim.

Reproduce with root `bun run build`, `bun run --cwd desktop package`, then
`bun run --cwd desktop smoke:restart:packaged --active-close` and
`bun run --cwd desktop smoke:restart:packaged`.
