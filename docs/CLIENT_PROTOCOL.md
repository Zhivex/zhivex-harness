# Shared client protocol v1 (experimental)

HAR-HU-21 defines an in-process, presentation-independent contract. CLI and desktop
clients can use the same `createHarnessClientAdapter(harness)` interface without
parsing terminal text. The host constructs the Harness with its trusted workspace,
scope, provider, model, credentials and tool policy. Requests cannot change these.
The existing CLI/JSONL interfaces remain unchanged.

## Inventory and boundaries

| Existing engine surface | Client operation |
| --- | --- |
| Canonical Harness workspace and AgentStoreScope | project.get |
| openCliSessionStore / list / create / rename | session.list/create/get/rename |
| runHarness and appendUserMessage | run.start and approval.resolve |
| Scoped AgentRunStore.load and pending approvals | run.get |
| cancelHarnessRun with final/cascade | run.cancel at a durable checkpoint |
| AgentStreamEvent / existing CLI schema v1 | Not exposed as a replay stream in this protocol |

The adapter owns its session-index connection, but never closes the host's Harness.
It supports **one exclusive writer**, serial command execution, and direct awaited
responses. A second mutation while a different command executes receives BUSY (competing approval decisions receive REVISION_CONFLICT);
identical idempotent retries join the first response. There is no listener, remote
authentication, live streaming/replay, cross-process lock, automatic CLI transport migration. The local service now supplies protected transport, persisted activity and coordinated active cancellation; see [Local service](LOCAL_SERVICE.md). CLI transport migration is tracked in HU-25. The host must prevent other adapters/CLI processes from writing
the same scope concurrently. Expected revisions here are preconditions within that
exclusive-writer boundary, not a distributed concurrency guarantee.

## Version, identity and capabilities

Call `adapter.negotiate([1])` before commands. Success supplies `protocolVersion: 1`,
`connectionId`, `projectId` and supported `capabilities`. An unsupported list yields
`{ok:false,error:{code:"VERSION_UNSUPPORTED"}}` without creating runs. The command
request JSON Schema is `contracts/client-protocol-v1.schema.json` and the TypeScript
unions and Zod schemas are exported from the package root as Experimental APIs.

`projectId` binds the canonical workspace plus tenant/user/namespace scope; it is
an opaque identifier, not a filesystem path or authorization token. Session and run
IDs come from the engine. A run must belong to the specified session and project.
Unknown or cross-project identities yield NOT_FOUND without leaking another scope.
The host's authenticated identity/scope cannot be supplied or overridden in a command.

`connectionId` is an unpredictable instance epoch, not remote authentication. A
closed/recreated adapter rejects the old epoch with CONNECTION_EXPIRED. Re-negotiate
and query durable state after reconnecting; never blindly replay old mutations.
The adapter does not erase sessions or runs on close.

Protocol major 1 is the only accepted request version. Incompatible request fields
are rejected (strict validation, INVALID_REQUEST); negotiate again when upgrading.
Only advertised capabilities may be assumed. `run.cancel.checkpoint` and `run.cancel.active` are separately advertised. Adding an optional operation requires
capability negotiation; changing existing field meaning requires a new major.

## Command envelopes

Every request has this shape; JSON serialization is sufficient:

```json
{"protocolVersion":1,"requestId":"request-1","connectionId":"connection-example","command":{"method":"project.get","projectId":"project-example"}}
```

Responses echo the request ID and use a discriminated result:

```json
{"protocolVersion":1,"requestId":"request-1","ok":true,"data":{"kind":"project","projectId":"project-example"}}
```

```json
{"protocolVersion":1,"requestId":"request-1","ok":false,"error":{"code":"NOT_FOUND"}}
```

Malformed envelopes return INVALID_REQUEST with `requestId: null`. Exception text,
stack traces, credentials and provider payloads are never copied into error envelopes.
Known Qwen stream failures may include optional `providerDiagnostic` with
`provider: "qwen"`, `diagnosticCode: "QWEN_SSE_EVENT_INVALID"`, `transport`
(`chat` or `responses`), `reason` (`invalid_json` or `invalid_event`) and
`retryable: false`. Failed `run.get` results may include an `error` projection
with that same diagnostic. The client error code remains `EXECUTION_FAILED`;
the typed Harness error category is `provider`. Historical message-only errors
cannot recover missing fields. Newly caught failures retain only these safe
fields in run metadata when the installed SDK did not persist them itself.
Successful answers and exact approval actions are **sensitive workspace content**:
a future transport must authenticate access and must not log or render them as trusted
HTML/shell instructions. Hashes identify the exact action; they are not signatures
or a replacement for the engine's signed approval validation.

| Command | Additional fields | Success data kind | Representative error |
| --- | --- | --- | --- |
| project.get | projectId | project | NOT_FOUND |
| session.list | projectId, optional search | sessions | BUSY |
| session.create | projectId, idempotencyKey, optional title | session | IDEMPOTENCY_CONFLICT |
| session.get | projectId, sessionId | session | NOT_FOUND |
| session.rename | projectId, sessionId, expectedRevision, idempotencyKey, title | session | REVISION_CONFLICT |
| run.start | projectId, sessionId, expectedRevision, idempotencyKey, prompt | run | INVALID_STATE |
| run.get | projectId, sessionId, runId | run | NOT_FOUND |
| task.get | projectId, sessionId, runId, projectionVersion: 1 | task | VERSION_UNSUPPORTED / NOT_FOUND |
| approval.resolve | projectId, sessionId, runId, expectedRevision, idempotencyKey, decisions | run | APPROVAL_MISMATCH |
| run.cancel | projectId, sessionId, runId, expectedRevision, idempotencyKey | run | REVISION_CONFLICT |

## Task projection v1 (HAR-HU-73)

Negotiate `task.get` and `task.projection.v1` before using this additive read.
Protocol major 1 and all legacy commands keep their meaning. Older hosts without
the capability cannot provide this projection; clients must show it as unavailable.
The host must already have a task contract and a session binding for its runs.
This command creates neither a task nor a budget and does not provide a new execution
or acceptance API. CODE-05 presentation remains separate.

```ts
import { reduceHarnessTaskProjection } from '@zhivex-ai/harness/protocol';

const hello = adapter.negotiate([1]);
if (!hello.ok || !hello.capabilities.includes('task.projection.v1')) {
  throw new Error('Task projection unavailable');
}
const scope = { connectionId: hello.connectionId, projectId: hello.projectId,
  sessionId, runId }; // IDs selected from this host's session index.
const response = await adapter.dispatch({ protocolVersion: 1, requestId: 'task-read-1',
  connectionId: scope.connectionId,
  command: { method: 'task.get', projectId: scope.projectId, sessionId, runId,
    projectionVersion: 1 } });
if (response.ok && response.data.kind === 'task') {
  const view = reduceHarnessTaskProjection(null, response.data.projection, scope);
  // Display view.snapshot as untrusted text. This helper never executes anything.
}
```

The same request uses `/command` on the existing authenticated local service.
Reads remain available while admission is busy or paused. The host checks the full
task-account run set against the selected session before reading run journals or
artifacts; mixed-session accounts fail closed. An older requested run identifies
the task, but `observedRunId` and `historicalRequest` explicitly identify its latest
recorded run. Missing runs never turn an earlier delivery into the current result.

The strict DTO carries:

- Contract revision/digest, retained operator objective with provenance, run revision
  and durable execution status. No provider response or hidden reasoning is included.
- Observed and delivered snapshot digests, contract path labels, and current/stale/
  missing correspondence. No arbitrary file path or artifact-content request exists.
  Artifact references stay under the same project/session/run read boundary.
- Checks reconciled against the current contract, exact native bytes and completed
  tool journal. `structure: verified` is deterministic evidence only; semantic review
  stays `pending` and final acceptance stays `not_recorded`. Human requirements retain
  their canonical `pending` state. Execution completion is never human acceptance.
- Authoritative confirmed/reserved/unknown token quantities, remaining allowance,
  frozen limits and account revision. Reservations are admission estimates, not
  confirmed consumption; a separate token estimate is not recorded. Monetary
  confirmed-call estimates, reservations and unknown exposure remain estimates, not
  invoices. Unknown quantities stay null/unknown, never invented zeros.
- Read-only/recorded/unknown effect counts and missing-evidence flags. Provider stop
  remains unconfirmed. Next action explains wait/reconciliation/review/explicit
  continuation, preserves contract/receipts/budget/effects and never grants execution
  authority or automatic replay. A persisted running status alone does not prove a
  live worker; uncertain finalization requires reconciliation.

Genuine legacy contracts without a task account show `legacy_not_enabled` and null
budget values. An existing account with a missing binding, an unreadable bound
account, incomplete backup, or conflicting identity is an error, not legacy mode.
HAR55/56 acceptance, HAR58 evidence principles and HAR70/71/72 ledgers/receipts remain
the authority; this DTO stores no alternate ledger or acceptance state.

Snapshots are derived on demand and revalidated before publication. The host bounds
the serialized DTO to 64 KiB, each display string to 2,048 UTF-16 code units (with an
explicit truncation flag), check/review lists to 32 and contract path labels to 256.
Oversized evidence fails closed. Only allowlisted fields leave the host; roots,
known secrets and credential patterns are redacted before publication. In-process
hosts supply `taskProjectionSensitiveValues`; the local service includes its token,
configured sensitive values and relevant credential environment values. Redaction
does not make arbitrary workspace text trusted or HTML-safe.

### Replay and reconnection

`sequence` is assigned at read admission within `connectionId`, not at completion.
The pure browser-compatible reducer only replaces a snapshot in the caller's
negotiated connection/project/session/run scope. Duplicate and older responses are
ignored; conflicting duplicates, unsupported versions and wrong epochs request a
fresh read. It never adopts a connection ID from an incoming response.

Existing activity events are invalidations, not task snapshots or instructions to
execute. After a relevant page, read `task.get` again. A repeated/out-of-order event
may cause another harmless read; it cannot recreate effects. When `/events` reports
`cursorExpired`, discard assumptions derived from missing history and obtain a new
task snapshot. After service restart, negotiate again, set the expected epoch and
read durable state; never replay mutations or accept old-epoch snapshots. This is
snapshot convergence, not a new event store, streaming protocol or delivery guarantee.
Callers should coalesce refreshes and retry a changing snapshot with a bounded policy.

### Finite task errors

Task-read errors add `taskDiagnostic` to the existing error envelope, with a finite
cause, `impact: projection_unavailable`, and the action below. Raw exception text,
paths, provider payloads and journals are excluded. Malformed command shapes retain
the existing `INVALID_REQUEST` envelope. Unsupported versions never execute work.

| Cause | Client code | Safe action |
| --- | --- | --- |
| UNSUPPORTED_VERSION | VERSION_UNSUPPORTED | review_configuration |
| OUT_OF_SCOPE | NOT_FOUND | review_configuration |
| UNSUPPORTED_HOST / CONTRACT_UNAVAILABLE | INVALID_STATE | review_configuration |
| EVIDENCE_UNAVAILABLE | INVALID_STATE | reconcile |
| SNAPSHOT_CHANGED | REVISION_CONFLICT | retry_read |
| PAYLOAD_LIMIT | CAPACITY_EXCEEDED | review_configuration |

Inside a successful projection, terminal failure/cancellation/timeout and incomplete
evidence have separate finite diagnostics with `acceptance_not_established` impact.
No diagnostic recommends replaying an uncertain operation. This cut supports one
trusted native workspace/SQLite writer and sequential host handoff only. OCI task
projections, multiagent scope, new document/web adapters and final semantic/human
acceptance are unsupported; legacy execution APIs are unchanged.

### Reproducible installed consumer

Build and pack Harness and Code from the same clean candidate following their
normal build instructions. The existing HAR75 installer accepts an optional sixth
argument selecting the HAR73 profile; it freezes/rechecks consumer, manifest and
tarball hashes and verifies Code/service share the installed engine:

```sh
node scripts/task-recovery-lab-installed.mjs /tmp/harness.tgz /tmp/code.tgz \
  /absolute/path/to/node /tmp/projection-node 90000 projection
```

Repeat with supported Node 22/24 and Bun. `evaluations/task-projection.json` fixes
the reused HAR75 fixture and ten consumer scenarios: version negotiation, readonly
snapshot, redaction, duplicate/out-of-order responses, artifact scope, expired cursor,
paused admission, fresh-epoch restart, artifact drift and legacy budget. Source
regressions additionally exercise corrupted/missing bindings and runs, changing
snapshots, read admission races, active mutations and payload limits. These are offline
contract tests, not CODE-05 UI acceptance, live-model quality or an external pilot.
| checkpoint.list | projectId, sessionId | checkpoints | NOT_FOUND |
| checkpoint.inspect | projectId, sessionId, checkpointId | checkpoint | NOT_FOUND |
| checkpoint.capture | projectId, sessionId, expectedRevision, idempotencyKey, turnId, paths | checkpoint | EXECUTION_FAILED |
| restore.prepare | projectId, sessionId, checkpointId, expectedRevision, idempotencyKey, expected (path/digest map) | restore | REVISION_CONFLICT |
| restore.get | projectId, sessionId, operationId | restore | NOT_FOUND |
| restore.apply | projectId, sessionId, operationId, expectedRevision, idempotencyKey, reviewedProposalId | restore | EXECUTION_FAILED |
| restore.recoverFork | projectId, sessionId, operationId, expectedRevision, idempotencyKey, forkSessionId | restore | EXECUTION_FAILED |

Checkpoint mutations use the source session revision. Checkpoint/restore IDs must
belong to that session and the host workspace/scope. Capture requires an existing
terminal turn and explicit paths (at most twenty existing text files, 64 KiB each).
Inspection reports unavailable files and mode conflicts and explicitly excludes
creation, deletion, binary files, mode rollback and full workspace snapshots.

Prepare uses the exact digests observed during inspection and returns the prepared
operation plus a diff. Clients must show that diff and obtain explicit review before
sending its `reviewedProposalId` to apply. A digest identifies content; it is not proof
of a human decision. Hosts must enforce their UI review boundary. The Desktop generic
command IPC does not accept apply/recover requests; its dedicated review flow is required.
Local CLI checkpoint commands use the same engine API. Desktop exposes checkpoint
review through dedicated host-issued tickets; generic IPC cannot apply or reconcile
a restore. The CLI does not yet route checkpoint commands through `--service`.

Restore responses contain operation metadata and an available/unavailable preview,
without duplicating the captured contents. Successful apply includes the derivative
session to open and preserves the original. Listing includes interrupted and completed
operations. After reconnecting, query the same operation before resuming: completion
is durable and applying again returns the existing derivative. An uncertain fork must
be reconciled with its exact existing child ID via `restore.recoverFork`; this does not
apply files or authorize a subsequent restore. Stale contents, missing files, mode
changes and partial filesystem outcomes fail closed. Apply/recovery also reject source
conversations with unfinished durable runs.

Session documents contain sessionId, revision, optional title and ordered runId/status
references. Lists use the existing bounded session store (default 50; no pagination
capability in v1). Queries reconcile references with the durable run states. Run
results include the current session plus runId, revision, status, output and pending
approvals. Status is authoritative; the presence of output never implies completion
or successful verification. A failed operation can have persisted effects: after
EXECUTION_FAILED inspect the session and run before deciding the next action.
If an interrupted start has an index reference but no durable run, INVALID_STATE
fails closed; automatic repair of such orphan references is not promised here.

## Revisions, idempotency and approvals

Session mutations use the **session revision**. Approval and cancel mutations use
the **run revision**. Read the latest response/query before a new mutation; a mismatch
returns REVISION_CONFLICT before executing the action. Refresh may advance session
revision when reconciling engine state. A new run is allowed only after the previous
run is terminal and includes its retained messages plus the new user message.
A waiting approval must be resolved or cancelled before starting another turn.

Every mutation requires an idempotencyKey. The key is unique across methods in this
connection and is bound to the canonical command including its expected revision.
An identical retry returns a copy of the original success/error receipt, updating
only requestId, even if later state has changed. Different content with the same key
returns IDEMPOTENCY_CONFLICT. Keys and receipts are kept in memory for the connection
lifetime (maximum 1,024; CAPACITY_EXCEEDED stops new mutations rather than evicting
receipts and risking repeated effects). This is **not durable exactly-once delivery**.
BUSY/CONNECTION_EXPIRED/validation errors are admission errors, not consumed receipts.
New connections require state reconciliation; changing a key is not a safe retry
strategy after uncertain execution.

An approval result includes `approvalId`, provider, kind, action and a SHA-256 digest
of the full canonical approval request. `approval.resolve` must return exactly one
explicit boolean decision for every current pending approval; missing, duplicate,
unknown or altered identities/digests return APPROVAL_MISMATCH. The adapter creates
engine approval responses from stored requests, never client-supplied tool arguments.
The Harness still validates signed payloads, policy and workspace digests. Files
changed after preview invalidate the edit even when the client revision matches.
Denial is explicit and can produce EXECUTION_FAILED under the engine's strict tool
policy; it never applies the denied edit or fabricates completion.

Cancellation is final and cascades from a paused run. Terminal runs are unchanged.
For a currently owned active run, run.cancel first records cancellation in the durable store and then aborts the owner invocation; run.get remains available while execution is active. A reconstructed active state without a live owner rejects checkpoint cancellation rather than guessing about effects. Approval previews include expiresAt (15 minutes from the persisted checkpoint by default); late decisions fail with APPROVAL_MISMATCH. No shell command executes in the client.

## Executable reference client and acceptance

```sh
bun --no-env-file run scripts/client-contract-smoke.ts
bun test tests/client-contract.test.ts
# The same client can target a locally installed artifact:
bun --no-env-file run scripts/client-contract-smoke.ts /absolute/consumer/node_modules/@zhivex-ai/harness/dist/index.js
```

The client serializes envelopes, opens a project, creates/renames a session, starts
an edit, previews the exact action, approves, verifies the actual file, repeats the
approval without repeating effects, starts another turn and cancels its pending edit.
It uses the real Harness and durable stores with an offline mock model; no provider
credentials/calls, HTTP listener, terminal parser or desktop application is involved.
Regressions also cover revision/digest drift, denial, concurrent duplicate requests,
connection renewal, receipt-copy isolation and cross-session identifiers.

## Complete file approval previews (HU29)

`run.get` accepts optional `includeReview: true`. Ordinary polls retain their prior
shape and cost. The service derives paths and contents exclusively from the scoped
run's pending approvals. Supported file mutations return `filePreview` with the
proposal identity, full before/after text and digests; unavailable bases return only
`status: unavailable`, without file/error details. Protected descriptor reads and
fatal UTF-8 decoding preserve exact BOM/CRLF bytes. Review payloads are bounded
and never silently truncated into an approvable preview. Mutation-time digest
checks remain authoritative: a preview is not a filesystem lock.

New terminal-run continuations close missing tool-result transcript entries with
an explicit unknown-outcome context record. This prevents dangling calls from an
older rejected/failed run being treated as fresh pending requests. It does not
assert an effect, generate a successful receipt or authorize replay. Error activity
uses the persisted run status when available rather than always saying interrupted.

Workspace adds read-only `previewPatch` and `previewReplacement` methods. This is
an additive Stable API change; the reviewed declaration snapshot includes the
transitive Workspace signatures. It does not remove or alter existing methods.

## Durable approval decisions (HU29)

`approval.resolve` saves bounded decision intent in run metadata before invoking
execution. Each row records approval identity/digest, reviewed revision, time,
explicit approve/deny and a hash of the tool input; it does not duplicate raw
arguments, file contents, credentials or command output. An already admitted
approval cannot be authorized again after a lost acknowledgement or reconnection.
The run can still be inspected or cancelled; an unknown effect is never retried
implicitly. The per-run admission limit is 512 decisions and fails before execution.

`run.get` returns decisions with evidence reconstructed from the durable tool journal.
Matching requires run, provider call id, tool name and input hash. A file decision is
`applied` only with a valid patch-result receipt; check success requires exit 0 without
timeout. Rejection, failure and unknown outcome remain distinct from run completion.
The projection contains digests and allowlisted receipt fields, never stdout/stderr.

Responses include `decisionTotal`, at most 25 decisions and an optional
`decisionNextOffset`; pass `decisionOffset` to `run.get` to read later pages. A fresh
read starts at offset zero. Legacy runs have no service decision ledger and return
an empty history, rather than fabricated historical approvals.

## OCI review and patch-bound verification

OCI approval previews read existing artifacts through the configured environment's
`previewPatch` operation. They check run/scope/environment binding, immutable patch
identity, host content and modes, without acquiring a runtime or creating a missing
snapshot. Full UTF-8 contents and mode transitions include recoverable deletions.
Invalid UTF-8 patches fail instead of displaying or importing replacement bytes.

Verified environment imports and verified reviewed edits expose journal evidence
only when the import receipt matches the run and patch, verifier argv matches the
approved input, and verification exited zero without timeout. Reviewed-edit proof
also matches its proposalId to the approved changes. Plain checks are explicitly
not certified against a specific patch. All fields remain subject to host redaction.

The environment preview method is additive on the Beta environment interface;
factory return signatures were reviewed and their snapshot updated. Existing
execution and import methods retain their contracts and mutation-time checks.

The local-service constructor optionally accepts a trusted `approvalNow` clock.
It is not a client command or IPC capability. Desktop expiry tests advance only
the service clock to prove server-side rejection while the review receipt remains
unexpired in the main process.

### Experimental policy inspection

`policy.get` takes only `projectId` and returns `{ kind: "policy", policy }`.
The versioned policy document is the same host snapshot returned by
`inspectHarnessPolicy` from `@zhivex-ai/harness/engine`. It contains configuration,
not proof of tool or OCI execution. Clients cannot supply policy overrides in
this command. The read remains available while mutation admission is paused or
a run is active, and does not create a session, authorize an approval or execute
a tool. Rule paths and host filesystem locations are omitted.
While a host-prepared runtime is active, the query reflects that runtime. Before
preparation and after release it reflects the base host; decision events retain
the digest and backend of the runtime that evaluated them.

## Recorded check evidence

Beta run-result JSON adds `verification`: numeric exit codes, timeout and pass
flags for known check tools, with counts and `coverage: "recorded-checks-only"`.
It omits command argv, repository output and arbitrary tool payloads.
`taskVerified: false` distinguishes this observation from contractual task success
or human acceptance. Existing status/exit-code and schema-version contracts remain
unchanged. Code inspection/export derives the same safe projection from completed
tool-journal entries; the engine inspection API signature is unchanged.


## Task controls (CODE-HU-05, experimental)

Negotiate `task.control.v1` and each command before showing mutation controls.
The strict command schema remains protocol v1. The host creates the contract;
clients cannot supply a contract, receipt, budget ledger or execution grant.

| Method | Additional input | Result |
| --- | --- | --- |
| `task.start` | session, expectedRevision, idempotencyKey, bounded brief with goal/paths/checks/constraints and explicit input/output/total token limits | run |
| `task.review` | session, run | taskReview |
| `task.keep` | session, run, reviewId, idempotencyKey | task + humanDecision |
| `task.revise` | same review binding + correction (1–500 characters) | task + humanDecision |
| `task.continue` | same review binding + prompt (1–2000 characters) | run |

A taskReview contains a redacted bounded Git diff, fresh projection, allowed
actions, a `complete` flag, operator-decision status and a five-minute, one-use host token. Tokens
bind connection, session, run revision, contract, current snapshot, task budget
revision and Git status/diff identity. The web host additionally binds tokens
to its authenticated browser identity and workspace. Missing, consumed, expired
or changed reviews fail closed. Hidden/truncated review content cannot enable keep. A command retry with the same idempotency key
returns its existing response; a renderer must read state after a lost response,
never manufacture another mutation key automatically.

Keep records `humanDecision` with `explicit_operator_review` provenance under
task-account exclusion and run CAS. It does not change the projection's semantic
pending/acceptance-not-recorded fields, commit files or imply independent human
quality measurement. A changed contract or snapshot makes the record stale.
Revise appends a bounded pending human requirement without executing work.
Continue uses the original durable account and rechecks the reviewed admission
tuple inside runtime continuity; it cannot replenish credit or replay uncertainty.
Ordinary run.start is rejected in sessions retaining governed task authority.

A continuation rejected before admission can have a failed session attempt with
a host-owned reference to its prior admitted run. Reads resolve this reference
only within the same session and only when the attempt is absent from the budget
account. The projection preserves the requested runId, exposes observedRunId and
historicalRequest, and retains stale/missing checks honestly. New review commands
must target observedRunId. No budget admission or consumption is fabricated.

Migration: fields and commands are additive and experimental. Existing projection
version 1, legacy chat and exact tool approvals remain intact. Match host and Code
builds; unsupported hosts display an unavailable task-control state. See
[Code web tasks](CODE_WEB_TASKS.md) for native workspace limits and offline QA.
