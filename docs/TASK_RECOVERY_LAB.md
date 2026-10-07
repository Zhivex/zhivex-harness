# HAR-HU-75: installed failure laboratory, phase one

This is a deterministic **service/engine/receipts laboratory**, not acceptance of
HAR-HU-75 as a whole. HAR73's public task projection and CODE05's task review UI
are explicitly pending. Existing Code CLI/web gates remain regression gates;
they cannot certify a panel that does not exist yet. CODE-HU-03/RC1 evidence keeps
its historical identity and is not reopened by this laboratory.

Scope comes from [HAR61](https://app.notion.com/p/3ef777b104f6814db523e89f5e1133b9)
and [HAR75](https://app.notion.com/p/3ef777b104f681acb4a4ed3d812b248a). The laboratory
is based on HU72 at `b64f7d15ed2d8e6fabd027cee51bafbf4a8c41b7`, using existing
HAR55 contracts, HAR56 receipts, HAR58 redacted governance reports and HU70/71/72
budget, cancellation and continuity APIs. No runtime, persistence format, public
protocol, SDK or security-policy change is needed. No paid model or pilot runs.

## Reproduce with one candidate

Use Bun 1.4 tooling, `CI=1`, `umask 022` and the repository's normal frozen install,
root/Code builds and local engine linking instructions. Commit the candidate;
the laboratory refuses a dirty checkout. Pack both products from that checkout:

```sh
bun run build
bun run build:code
bun pm pack --ignore-scripts --filename /tmp/hu75-harness.tgz
bun pm pack --cwd packages/code --ignore-scripts --filename /tmp/hu75-code.tgz
node scripts/task-recovery-lab-installed.mjs /tmp/hu75-harness.tgz /tmp/hu75-code.tgz /absolute/path/to/node /tmp/hu75-node-report
bun scripts/task-recovery-lab-installed.mjs /tmp/hu75-harness.tgz /tmp/hu75-code.tgz /absolute/path/to/bun /tmp/hu75-bun-report
```

Repeat Node with each supported Node line (22.13 minimum and 24). The installer
uses the established tarball-consumer pattern: a private temporary npm install,
no install scripts, no source aliases, an exact local candidate engine override,
and cleanup in `finally`. All fixtures live under the owned installation root.
Timeout/output overflow kills the owned process group and reports cleanup as
**unconfirmed**: native commands can create separate groups, so forced-stop
cleanup is not certified. A failed report never passes the laboratory. The
optional fifth argument can shorten the 90000 ms consumer timeout for a local
negative control; it cannot extend that limit. It verifies that Code resolves the identical installed
engine used by the service/receipt consumer. Source SHA, clean state, fixture and
consumer digests, artifact hashes, dependency/runtime versions and cleanup are
recorded. Source/pack binding requires the builds and packs above; hashes alone
are not a cryptographic source attestation.

Run the existing Code installed journey with those **same tarballs**, under both
Node lines, retaining its separate report:

```sh
CODE_JOURNEY_OUTPUT=/tmp/hu75-code-journey node packages/code/scripts/installed-journey.mjs /tmp/hu75-code.tgz --candidate-engine /tmp/hu75-harness.tgz
```

`evaluations/task-recovery-lab.json` freezes fixture digest, required scenario IDs,
limits, source-regression references and omissions. No human timing, quality,
latency percentile or cost-per-accepted-task claim follows. HAR74 must ratify its
rubric, thresholds, candidate and fixture manifest before measurement. Fixed mock
usage is synthetic; unavailable pricing stays unknown, never a zero-cost result.

## Scenario matrix and acceptance boundaries

Every installed report row records confirmed run/revision/effects/checks,
missing evidence, original budget, next action, result and pending work. Existing
HAR58 governance export is included where a durable run exists; its unavailable
artifact fields remain unavailable. The outer laboratory report binds package
hashes and does not overwrite the governance evidence or invent a signature.

| Scenario | Boundary / expected state and effect | Budget / next action | Evidence and pending acceptance |
| --- | --- | --- | --- |
| Failed start | Engine admission refuses before model or effect | No confirmed use; original insufficient credit retained | `failed-start`; UI failed-start state pending |
| Exhaustion after work | Synthetic over-reservation receipt exhausts original credit; next dispatch refused | Receipt charged; restart cannot mint credit | `exhaustion-after-work`; real provider behavior not measured |
| Normal control | Native check succeeds at current snapshot; execution completed, human review pending | Reported synthetic use retained | `normal-control`; UI exact-snapshot acceptance pending |
| Contract/artifact drift | Old brief rejected; authorized revision retained; changed artifact invalidates check | Original account, no extra dispatch | `contract-artifact-drift`; browser review race pending |
| Obsolete approval | Cancelled authority refuses prior approval; zero effect | Closed admissions; no automatic reopening | `obsolete-approval`; UI approval/revision binding pending |
| Concurrent cancel, late usage | Same-host cancellation closes admission while receipt arrives | Final receipt retained across restart; provider stop unconfirmed | `concurrent-cancel-late-usage`; UI ordering pending |
| Concurrent cancel, unknown usage | Partial work never becomes accepted or zero usage | Unknown exposure held; competing dispatch refused | `concurrent-cancel-unknown-usage`; UI unknown-cost rendering pending |
| Disk-full final save | Injected ENOSPC after real effect and receipt; no completed final checkpoint | Existing account retained; continuation blocked | `disk-full-final-save`; injection is not physical disk exhaustion |
| Crash before receipt | SIGKILL after one real native effect, before receipt; previous process exits | Pending invocation/unknown effect blocks replay | `crash-before-receipt`; no concurrent host takeover |
| Crash after receipt | SIGKILL after durable receipt, before finalization; effect still occurs once | Pending invocation blocks continuation | `crash-after-receipt`; no orphan clearing API implied |
| Compaction / hostile evidence | Real semantic compaction retains operator constraints; assistant prose and fake citation remain unverified | Utility usage counted; no effect or permission expansion | `compaction-untrusted-evidence`; browser active-text/citation behavior pending |
| Native path boundary | Traversal and external symlink read refused; synthetic sentinel unchanged | Zero dispatch/effects | `native-path-boundary`; trusted local workspace only |
| Disconnect / session isolation | Real local HTTP connection destroyed; accepted work recorded once; event replay after disconnect and service restart; foreign project/mixed session refused | Public task budget projection unavailable, explicitly null | `service-disconnect`; HAR73/CODE05 service→task-budget→UI join pending |

The greeting fixture protects the package script and checker, retains the named
export and independent exact-output oracle, and records an explicit effect
counter. Only the disk-full/crash cases create `inject-effect`, activating the
counter mutation. Those effects intentionally invalidate snapshot checks and
must not be represented as verified delivery. All assertions are deterministic;
resource durations/cleanup are laboratory diagnostics, not user productivity.

## Regression and exit gate

Run the `sourceRegressions` in the manifest with Bun; preserve the complete root
`bun run check`, Code tests/typecheck and installed journeys. These source suites
retain cancellation transport races, late monetary receipts, compatibility,
retention, redaction, exact check/argv binding and local-service security tests.
Do not relabel a source test as installed coverage. Adversarial strings and
sentinels are synthetic; neither a real secret nor a third-party target is used.
Reports omit free-form model/tool text and credentials; subprocess failures emit
static diagnostics. A failed, absent, duplicated or substituted scenario fails
the installed laboratory. No failed attempt may disappear from the evidence.

Phase-one review requires every declared case to pass on the exact packages,
independent review with no unresolved critical/high finding in this phase, and
explicit retained gaps. Full HU75 remains **not accepted** until HAR73/CODE05
complete the versioned projection, reconnect/cursor/idempotency handling,
browser isolation/redaction, active text/citation handling and human review on
the same integrated candidate, followed by separately authorized HAR74 work.

Only one native SQLite writer is supported. Sequential handoff starts after the
previous process is proven terminated. Unknown effects are inspected, never
automatically repeated; cancellation is not provider-stop proof. Concurrent host
takeover, arbitrary storage failures, new formats/SSRF, hosting, connectors,
external teams and paid campaigns are outside this laboratory.
