# HAR-HU-29 — desktop approval review closure

Implementation complete; pending publication. This report supersedes the earlier
HU29 progress reports for acceptance status, without expanding their evidence.

| Acceptance requirement | Verified evidence |
| --- | --- |
| Files, complete before/after, commands and checks bound to run/patch | Packaged OCI fixture flow reads full base/destination, approves through React, imports exact host bytes and renders the verifier's patchId/argv/exit-zero proof. Unit/integration tests cover OCI operations/modes, stale/protected bases and mismatched proof rejection. |
| Scoped approve/reject; expired and competing decisions rejected | Packaged normal flow rejects then approves exact edits. Its service-only clock advances beyond approval TTL while main receipts remain unexpired; UI reports rejection, run remains pending and no decision is admitted. A second client's earlier receipt is then rejected after the winning decision, leaving one admitted execution. |
| Pending, rejected, failed, applied; repository content cannot activate controls | Packaged history reload shows rejected, applied and failed check evidence. Literal HTML-like content creates no active elements; isolated preload rejects direct approval bypass. Unit/integration tests cover missing/mismatched receipts, file drift failure, crash acknowledgement loss and reopened durable history. |

Final evidence:

- HAR_HU_29_PACKAGED_FINAL_2026-09-20.json: normal packaged flow including
  expiredApprovalRejected and staleApprovalRejected.
- HAR_HU_29_OCI_PACKAGED_FINAL_2026-09-20.json and
  HAR_HU_29_OCI_FINAL_2026-09-20.png: packaged OCI review and bound evidence.
- Full suite: 654 passed, 0 failed, 3721 assertions, 86 files.
- Root/desktop/tooling typechecks, docs and contract checks passed.

Reproduction:

```sh
bun run --cwd desktop package
bun run --cwd desktop smoke:packaged --empty-start
bun run --cwd desktop smoke:packaged --oci-review
bun test
```

The packaged flows use offline model fixtures. OCI uses an explicitly labeled
fixture runtime, not Docker: this verifies the Harness transaction, desktop UI and
artifact handling, not kernel isolation or live runtime certification. The package
is macOS arm64, unsigned and unpublished. Signature/notarization remain HU34,
as authorized by the user. No new provider calls or remote publication occurred.

The full goal remains active: HU30 recovery/alpha closure, HU31 worktrees, HU32
explicit Git delivery, HU33 credential storage, HU34 packaging/signature and HU35
updates/migration still require their own evidence.
