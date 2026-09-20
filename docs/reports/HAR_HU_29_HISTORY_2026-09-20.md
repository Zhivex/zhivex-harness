# HU29 — durable decisions and effect evidence

The service saves approval/rejection intent before execution, bound to the exact
run revision and approval digest. A bounded metadata ledger stores identities,
input hashes and decision times, without duplicating raw payloads or outputs.
Repeated authorization after acknowledgement loss or reconnection fails closed.

Read projections match the run's durable tool journal by run, provider call id,
tool name and input hash. Applied file changes require a patch-result receipt with
proposal identity and file digests. Failed tool execution and nonzero/timeout check
receipts are failed; denial is rejected; missing or mismatched evidence is never
converted into success. Decisions are exposed in pages of 25 (512 per-run limit).

The desktop offers a per-run history including earlier conversation runs. The
packaged Electron smoke reloads the renderer and reads rejected, applied and failed
check histories. Screenshot: HAR_HU_29_DECISIONS_2026-09-20.png. Machine report:
HAR_HU_29_HISTORY_PACKAGED_2026-09-20.json.

Validation: full suite 650 passed, 0 failed, 3697 assertions in 86 files. A subsequent
focused test additionally asserts that a stale-file execution appears as failed.
Root/desktop/tooling typechecks, documentation and contract checks passed. Installed
CLI/SDK package smoke passed under Node. Unit/integration tests also cover bounded
pagination, journal mismatches, unknown outcomes, lost admission acknowledgement,
and journal/history recovery through a newly opened harness. No live provider call
was needed. The macOS package remains unsigned and unpublished.

HU29's status-distinction criterion is now covered for the implemented desktop
flow. Remaining: patch-bound check evidence, OCI patch/mode review, and packaged
competing-client/expiry demonstrations. Those requirements and HU30–35 remain open.
