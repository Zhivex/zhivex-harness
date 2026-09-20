# HU30 — local alpha closure

Implemented and verified locally; pending publication. No beta, signed installer
or real OCI-provider certification is implied. HU31–35 remain separate work.

## Acceptance audit

| Requirement | Authoritative evidence |
| --- | --- |
| Open repository, request change, approve, verify and inspect final diff | Packaged OCI fixture journey in HAR_HU_30_CLOSURE_OCI_PACKAGED_2026-09-20.json; protected complete previews, explicit approval, exact verified patch receipt and final diff. This uses an offline OCI runtime adapter, not Docker. |
| Renderer loss, transport loss, worker restart and window close at pending approval; document pause/continuation behavior | Current packaged renderer/pending restart regression in HAR_HU_30_CLOSURE_RESTART_PACKAGED_2026-09-20.json; prior transport/worker and active-close demonstrations in HAR_HU_30_RECOVERY, HAR_HU_30_ACTIVE_RECOVERY and HAR_HU_30_ACTIVE_CLOSE reports. Behavior matrix and limitations are maintained in HAR_DESKTOP_ALPHA_BETA_ENTRY_2026-09-20.md. |
| Shared CLI/desktop session; prioritized alpha issues and beta entry criteria | Current restart regression compares full pending/completed session documents via built CLI, renames from CLI and checks the UI. Prioritized issues and beta gates are published in the HU30 Notion page and mirrored in HAR_DESKTOP_ALPHA_BETA_ENTRY_2026-09-20.md. |
| Remaining alpha P1: file effect/journal crash reconciliation | HAR_HU_30_EFFECT_CRASH_PACKAGED_2026-09-20.json and the fault procedure below. |

## Effect-boundary fault

Only with explicit host fixture flags, the worker wraps completeToolExecution for
the fixture replacement. After the actual tool returns from writing review.txt, it
records a bounded stage marker and sends itself SIGKILL before the journal commit.
This bypasses exception handlers and graceful cleanup. The hook is not an HTTP or
renderer command and never runs in the normal provider configuration.

The first app verifies the exact changed bytes and dead worker. After the app exits,
a fresh main/worker pair opens the existing project/session. The persisted run is
running and its journal-backed decision is unknown, with no applied final diff.
The old approval packet, captured before execution, is rejected as INVALID_STATE.

Immediate cancellation is rejected while the old worker's lease remains valid.
The fixture waits 31 seconds and cancels through the UI with a fresh revision.
A new user prompt completes a new run. The original decision remains unknown,
its decision count stays one, and both file bytes and modification time remain
unchanged. No tool is replayed and cancellation is not represented as rollback.
The outer driver confirms that both main and utility PIDs exit for each phase.

Reproduce: root `bun run build`, `bun run --cwd desktop package`, then
`bun run --cwd desktop smoke:restart:packaged --effect-crash`. Also run
`bun run --cwd desktop smoke:restart:packaged` and
`bun run --cwd desktop smoke:packaged --oci-review` for the current candidate's
ordinary acceptance journeys. Host-only fixtures choose native dialog responses;
native dialog appearance is not automated.

## Validation and delivery limits

667 tests passed, 0 failed, 3790 assertions across 89 files. Root, tooling and
desktop typechecks and contract checks passed. Current macOS arm64 unsigned
package passed effect-boundary recovery, ordinary restart/CLI/final-diff regression
and verified OCI fixture flow. Previous CLI/SDK installed-package verification
remains applicable: this increment changes desktop fixture/control code only.
HAR_HU_30_CANDIDATE_2026-09-20.json records the bundled app.asar size and SHA-256,
desktop/runtime versions and unsigned status. It identifies application code in
this candidate; it is not a signature or a hash of the entire Electron app bundle.

The historical diff is bounded and requires matching completed journal evidence;
older/unavailable snapshots remain explicitly unavailable. Lease-expiry waiting is
documented. Developer ID signing/notarization remain deferred by the user to HU34.
No push, PR, release or artifact publication is included in this closure.
