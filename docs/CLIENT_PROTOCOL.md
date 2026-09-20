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
stack traces, credentials and provider errors are never copied into error envelopes.
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
| approval.resolve | projectId, sessionId, runId, expectedRevision, idempotencyKey, decisions | run | APPROVAL_MISMATCH |
| run.cancel | projectId, sessionId, runId, expectedRevision, idempotencyKey | run | REVISION_CONFLICT |

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
