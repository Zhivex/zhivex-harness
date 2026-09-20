# Desktop alpha — prioritized issues and beta entry

This is the local alpha assessment for HU30. No beta release is certified.

| Priority | Open issue or verification gap | Evidence and required exit |
| --- | --- | --- |
| P1 | Forced interruption during a file effect lacks a packaged reconciliation demonstration. | Active-run recovery currently kills an offline waiting model. Inject a failure at the effect/journal boundary and prove that recovery distinguishes applied, failed and unknown effects without replaying the tool. |
| P2 | An active run recovered after a worker crash may require waiting for lease expiry. | Packaged recovery proves immediate BUSY and explicit successful cancellation after 31 seconds. The UI explains the wait. Beta documentation must retain the distinction between cancellation and rollback; independently leased descendants must not be falsely finalized. |
| P2 | Signing, notarization and external distribution remain unavailable. | User authorized unsigned packaging first. HU34 remains open until Developer ID, notarization, artifact verification and clean-machine installation evidence are available. |

## Entry into beta

1. Complete all HU30 criteria, including durable final diff, effect-boundary recovery,
   the interruption matrix and shared CLI/desktop session evidence. Resolve the P1
   issues above, or record an explicit scope decision from the product owner;
   passing unrelated tests does not waive them.
2. Implement and verify HU31–35 against their Notion criteria: managed worktrees;
   explicitly authorized Git delivery; OS-backed credentials; signed/verifiable
   macOS installation; recoverable, integrity-checked updates and state migrations.
   The unsigned alpha package is not evidence of those capabilities.
3. Run the scoped regression suite, contract/type/doc checks, installed CLI/SDK
   checks and packaged user journeys against the exact candidate artifact. Record
   versions, hashes, supported architecture and external prerequisites. OCI fixture
   verification is separate from a real Docker-backed run; offline providers are
   separate from live-provider verification.
4. Publish the candidate's known issues, recovery instructions and remaining
   limitations with reproducible evidence. Do not label the build beta or published
   while any required signing, integrity, recovery or isolation gate lacks evidence.

## Interruption behavior

| Event | Current behavior | Evidence |
| --- | --- | --- |
| Renderer process killed | Main offers a native reload/close choice. Reload reconnects and reads persisted state; it does not submit the prior prompt. The service can continue independently. | Restart smoke kills the renderer with a pending approval and verifies the identical run and approval before window closure. Fixture chooses reload through the production handler; native dialog appearance is not automated. |
| Temporary transport loss | UI preserves the cursor and retries reads; uncertain mutation responses require explicit reconciliation. | HU28 smoke, rerun in the HU30 active recovery packaged report. |
| Service dies at pending approval | Reopen project replaces only a dead owner and reads the same undecided run. | HU30_RECOVERY packaged report. |
| Service dies during a waiting run | No automatic resumption; explicit cancellation waits for lease availability and preserves recorded effects. | HU30_ACTIVE_RECOVERY packaged report. |
| Window closes at pending approval | Application drains admitted requests and both main/worker exit. Reopening from recent projects restores the session. Old main-process review receipts are invalid; the user reviews again before deciding. | Three-process restart smoke, including pending and completed CLI inspection and title mutation visible in desktop. |
| Window closes during unbounded active work | Main keeps the window visible and pauses new mutations. Stay resumes admission; cancel requests cancellation once per host. Unconfirmed cancellation leaves the app open. Both window close and application quit use the same path. | HAR_HU_30_ACTIVE_CLOSE report: packaged wait-for-cancel, stay, explicit cancel/quit, worker exit and same cancelled run after restart. Unit tests cover an unresponsive operation and unavailable host without forced close. |

The same session remains readable through the CLI's `--service` connection. The
restart test compares the full session document before approval and after completion,
then renames it through CLI and checks the desktop navigation. Both clients share
the host's authoritative state; neither starts an independent model for this test.

Resolved alpha issue: the earlier P1 for indefinitely waiting shutdown was reproduced
with a real active fixture and repaired. Service admission is paused atomically after
request parsing; a body sent before pausing cannot admit a mutation afterward. The
window remains available if work cannot be confirmed stopped. Evidence and limits:
HAR_HU_30_ACTIVE_CLOSE_2026-09-20.md. Native dialog appearance is not automated;
host-only fixture responses drive the production decision path.

Resolved alpha issue: final diff is now captured before decision execution and
projected on demand only when the applied receipt matches its proposal, paths and
content digests. Packaged restart verifies the original content after a later edit;
the OCI fixture verifies the final diff alongside the exact patch/check receipt.
Older or bounded-out archives show an explicit unavailable state. Evidence:
HAR_HU_30_FINAL_DIFF_2026-09-20.md. Effect-boundary crash reconciliation remains P1.
