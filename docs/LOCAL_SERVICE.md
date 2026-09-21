# Local runtime service and durable activity

The experimental shared service uses a Unix-domain socket in an owner-private
0700 directory. There is no TCP listener. The socket, bootstrap credentials and
ownership file are 0600. Every request authenticates a random 256-bit bearer token;
Origin and Sec-Fetch-Site browser requests are rejected, including authenticated
ones. The renderer must communicate through a trusted native bridge and must not
receive this token or general filesystem access.

```sh
bun run build
bun run service --workspace /absolute/repository --directory "$HOME/.zhivex-harness/service" --provider openai
```

The Node process inherits provider credentials from its host environment. It writes
only a `service-ready` JSON document with the private credential-file path to stdout;
tokens are never printed. The same service can be embedded through
`startHarnessLocalService(harness, {directory})`. It takes ownership of the supplied
Harness on successful startup. Startup failure leaves the host responsible for closing
its Harness. Directory paths must be short enough for Unix socket limits (100 bytes
including the socket filename), owner-private and non-symlink final directories.
Only macOS/Linux Unix transport is implemented; this does not certify other platforms.

## Transport and lifecycle

Use `readHarnessLocalCredentials(path)` (owner-private descriptor-bound read,
O_NOFOLLOW, maximum 4 KiB), then `requestHarnessLocalService(credentials, "hello",
{versions:[1]})`. Send the HU-21 strict envelope to `"command"`. There are no client
supplied provider keys, tool policies or workspace overrides in that envelope.

Requests are bounded to 128 KiB and decoded only after authentication. JSON is required;
unknown routes and malformed requests receive sanitized machine errors. Error bodies
never contain exceptions, stack traces or provider response payloads. Noninteractive
clients should reconcile state after a transport failure rather than retrying with a
new idempotency key.

One service owns a workspace/scope in the chosen service directory. A private exclusive
ownership file prevents duplicate startup in that directory. The launcher must use
one canonical directory for its configured workspace/scope; starting another owner
in a different directory is not a supported deployment. Two clients share the same
adapter, revisions, admitted command receipts and runtime owner. Duplicate idempotency
keys join the original result; competing approval decisions get REVISION_CONFLICT.
Approval digests, full pending-request set, run revision and expiry are checked before
the engine's signed payload and workspace preconditions.

Disconnecting a client does not abort an admitted command. SIGINT/SIGTERM stop
admission and drain accepted work before closing the engine and removing owned
transport files; the engine's configured timeout remains in force. Pending approvals
remain durable. Explicit cancellation of an owned active run first persists the
cancellation request, then aborts the owner invocation. Checkpoint cancellation is
final and cascades. Queries of the active run remain available during cancellation.

SIGKILL/process crash leaves the ownership file and runtime state. Startup fails
closed until explicit `--recover` or `recoverHarnessLocalService` confirms the recorded
PID is dead, checks ownership/types/modes and removes only transport files. A live
PID (including reuse) blocks recovery conservatively. Recovery does not delete databases,
replay a mutation or silently repair an uncertain tool effect. It rotates authentication
and the connection epoch; reconnect, query the durable session and inspect its pending
approval before a new decision. Existing engine journal/leases govern safe resumption.

## Replay contract

`requestHarnessLocalService(credentials, "events", {projectId, sessionId, after})`
returns a bounded page (up to 200 events). Each event carries schemaVersion 1,
eventId, monotonic sequence, sessionId, runId, timestamp and allowlisted activity.
Use nextCursor for the next page. Retrying a page returns identical stable event IDs;
clients deduplicate by eventId and must never execute tools in response to replay.
Sequences may have gaps because the database also contains other sessions/scopes.

The SQLite transaction saves event and materialized snapshot together. Defaults:
10,000 retained events per project/scope, seven-day event retention, 64 KiB per event,
256 KiB retained text per run, 1,000 runs and 2 MiB per session snapshot. Overflow
fails explicitly; snapshots mark truncated text. The existing session store bounds
session creation. Snapshot state is retained for reconstruction while old events are
pruned. An expired cursor returns `cursorExpired: true`, the current snapshot and a
new recovery cursor; replace the view from that snapshot and continue. A cursor ahead
of the session's sequence is rejected.

Tool inputs/results, model messages, provider payloads and raw errors are omitted
from events. Text is redacted before SQLite writes, including configured secrets and
common API token forms split across chunks; the unfinished token is buffered until
a boundary so partial secrets are not streamed. Very long unfinished tokens become
TRUNCATED. A crash can therefore omit an unflushed partial token; completed checkpoints
flush the remaining sanitized text. Activity output is untrusted text, never executable
markup. Expired-cursor snapshots preserve the same sanitized representation.

## Verification and limits

```sh
bun --no-env-file test tests/local-service.test.ts tests/service-events.test.ts tests/client-contract.test.ts
bun --no-env-file run scripts/local-service-smoke.ts
# The same Node subprocess smoke can target an installed artifact:
bun --no-env-file run scripts/local-service-smoke.ts /absolute/consumer/node_modules/@zhivex-ai/harness/dist/index.js
```

Integration tests exercise real Unix sockets, rejected credentials/origins, shutdown,
disconnect during streaming, active cancellation, concurrent decisions, expiry, durable
replay and secret splitting. The Node subprocess smoke injects SIGKILL at an approval,
recovers the dead owner, verifies identical approval and replay state, invalidates old
credentials, applies the approved edit exactly once and inspects its completed journal
receipt. Fixtures use mock providers; no live API or certification claim is made.

The CLI service adapter and the [desktop](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md) share this transport. Desktop signing, notarization and positive signed-update acceptance remain pending; the local unsigned build is not a production distribution.

The CLI adapter now consumes this transport via opt-in `--service`; see
[CLI.md](CLI.md#shared-local-service-experimental). It shares the direct CLI result
serializer and persists that projection with the run. New run admission explicitly
uses the host scope. No renderer or CLI can override it.

## Chat activity and concurrent readers

User prompts are recorded once per admitted run as redacted `user-message` activity.
Snapshots retain the prompt, bounded text, run status and up to 256 tool records per
run. A `run_check` tool result exposes only its integer exitCode and timedOut flag;
a successful tool transport does not prove a check passed. Raw stdout/stderr and
arguments remain excluded. Prompt display is bounded to 60 KiB after redaction and
marks truncation. Known secret values containing spaces are buffered across chunks.

Session/project reads remain available while a run is active. Those reads do not
refresh session revisions; clients query the selected run for current status. They
cannot submit another mutation through this read path. Service-mode CLI skips the
new user-message records so its existing JSONL event contract remains unchanged.

Desktop applies cursor and activity updates atomically and ignores duplicate or
older pages. Expired cursors replace the view from the durable snapshot. Main drops
raw engine output, the rich CLI result and approval arguments before returning a
run to the renderer, and redacts known host credential values and common token forms.
This is a renderer/activity boundary; it does not claim that all historical engine
state or the separate operator-facing rich CLI contract is a sanitized export.

Dead-owner recovery serializes through the workspace operations database's write
lock. The lock is acquired before reading transport ownership and released after
stale files are removed, with the owner lock file removed last. A concurrent
recoverer either fails with contention or rereads current ownership; it cannot act
on an old owner snapshot after another service starts. Database/session contents
are preserved, and the operating system releases the SQLite lock on process exit.

Recovery uses `busyTimeoutMs: 0` while opening the session index and zero SQLite
busy timeout for its ownership transaction. Contention fails immediately rather
than blocking the event loop while another recovery awaits filesystem I/O.
`OpenSessionStoreOptions.busyTimeoutMs` accepts 0–5000 ms and preserves the prior
5000 ms default for other callers. The additive signature snapshot is reviewed.
