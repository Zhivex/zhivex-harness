# Assistant phase 1: profiles and persistent local host

Implemented on 2026-11-10. Requires the local candidate; not published. See
[Assistant setup](../packages/assistant/README.md) for Bun commands.

Phase 2 adds [Telegram](ASSISTANT_TELEGRAM.md) through `--telegram-owner`
and `ASSISTANT_TELEGRAM_BOT_TOKEN`; the recovery guarantees described here
remain in place.

## Engine profile API

The stable `createHarness` constructor, `CreateHarnessOptions`, default coding
instructions and historical fingerprint remain unchanged. The additive
experimental `/engine` API is:

```ts
import { createProfiledHarness, GENERAL_ASSISTANT_PROFILE } from '@zhivex-ai/harness/engine';
const harness = await createProfiledHarness({
  workspace: '/absolute/private/workspace',
  agentProfile: GENERAL_ASSISTANT_PROFILE,
  provider: 'openai'
});
// Use runHarness/client APIs; close harness when its host stops.
await harness.close();
```

A profile contains `id`, `version`, `instructions` and `toolNames`. Construction
validates and snapshots it. Its complete content and normalized catalog enter
the durable fingerprint. Changing any of those fields prevents resuming old runs
under the changed profile, even if the caller forgets to bump the version.
The optional existing `toolNames` selector can narrow but cannot expand a profile.
Tools still pass through ordinary policy, approval, budget and isolation controls.

The general preset has no coding instructions or tools. It disables default
coding subagents and project-context loading. Coding subagents/delegation contracts
are deliberately unsupported with this new constructor until role profiles are
generalized; they fail explicitly. A trusted host may explicitly enable project
context. This API does not install arbitrary code from a profile.

## Host and ownership

`startAssistantHost({ directory, ownerId, engine?, recover? })` starts one
foreground owner of a workspace/scope. `engine` is trusted application input,
not a wire protocol: provider/model, profile, MCP clients/configuration, policy
and bounded execution options. The CLI offers only provider/model selection;
its default profile has no tools. The CLI never loads configuration code from
messages or workspace files. OCI is disabled in this Assistant host.

Directories must be owner-private regular directories; direct symlinks and
world/group-readable paths are rejected. `state/host.json` is created exclusively,
fsynced, and binds owner plus profile digest. A changed owner/profile or corrupt
binding fails closed. There is no profile-migration command in this phase.
Provider/model credentials remain host/environment-owned, not in this manifest.
Repeat provider/model settings on restart; Harness additionally checks run binding.

Harness owns SQLite conversations, checkpoints and approvals. Assistant stores
only its product binding; it does not duplicate these records or access SQLite
internals. `transport/` contains the private socket/credentials/ownership files.
The service permits one active engine mutation; competing independent clients
receive BUSY. The supplied Assistant client serializes its mutation requests,
which is stricter than per-conversation serialization. Reads and cancellation
remain available while an operation runs. Callers must use current revisions.

## Client example

Use the `credentialsPath` printed by the foreground host:

```ts
import { connectAssistant } from '@zhivex-ai/assistant';
const client = await connectAssistant('/absolute/private/transport/IDENTITY.json');
const created = await client.command({
  method: 'session.create', idempotencyKey: 'create-personal', title: 'Personal'
});
if (!created.ok || created.data.kind !== 'session') throw new Error('Create failed');
const session = created.data.session;
const reply = await client.command({
  method: 'run.start', sessionId: session.sessionId,
  expectedRevision: session.revision, idempotencyKey: 'message-1',
  prompt: 'Record this in our conversation: my favorite color is turquoise.'
});
console.log(reply);
```

After restart, reconnect, use `session.list`, `session.get`, `run.get` and
`client.events(sessionId)` to reconstruct current state. A new `run.start` on a
terminal run carries the prior bounded conversation through the existing engine
continuation path. This is conversation persistence, not personal long-term memory.
Activity replay is a bounded/redacted UI projection; it is not the canonical
execution journal. Retention uses the existing service defaults (7 days/10,000
events), with bounded snapshots for expired cursors.

## Approvals and restart behavior

- `run.get` with `includeReview: true` exposes the durable pending action and
  review details. The client must present them before constructing a decision.
- `approval.resolve` requires the run revision and each exact approval ID/digest.
  A pending approval blocks a new turn. Wrong digests or stale revisions fail.
- The service's existing 15-minute approval expiry is preserved across restart;
  restart does not renew authority. An expired action requires a new reviewed
  proposal (cancel the old pending run and start a new turn).
- Policies requiring explicit host review keep that requirement. The library
  exposes the service's trusted in-process `dispatchReviewed`; there is no remote
  shortcut that claims an operator reviewed an action.
- SIGINT/SIGTERM drains admitted work before closing. Pending approvals are not
  approved or denied as a side effect of shutdown. Default run timeout is 60s.
- After SIGKILL, startup without `--recover` fails on stale transport ownership.
  Recovery verifies that the old PID is dead, rotates credentials and preserves
  the runtime DB. A live or reused PID blocks recovery conservatively.
- Reconnect after recovery; old connection epochs/tokens are invalid. Inspect
  durable status before retrying. An interrupted active run or uncertain external
  effect is not automatically replayed. Cancellation/reconciliation stays under
  existing Harness contracts; this phase does not add a durable work queue.

No service is installed into launchd/systemd in this phase. Keeping it alive after
logout and machine boot is an operator deployment choice, not an implemented
installer feature. The local service is not exposed over TCP.

## Acceptance

The installed-consumer tests use an explicitly expanded test profile with one
approval-gated file tool to exercise real durable effects without live APIs.
Production default remains tool-free. Separate Node processes prove:

1. A pending approval survives SIGKILL and explicit recovery with identical ID,
   digest and expiry; a live owner's service cannot be stolen.
2. A tampered decision and a new turn while pending execute no effect.
3. An approved effect completes; clean restart and decision replay do not rewrite it.
4. The next model request contains prior conversation context after restart.
5. Owner changes, unsafe permissions and symlink directories are rejected;
   one client's concurrent mutations are serialized.

Engine tests additionally bind changes to profile ID/version/instructions/catalog,
verify default coding behavior and check the unchanged stable API snapshot.

### Local verification — 2026-11-10

- Build, documentation, architecture, stable-contract check and tooling typecheck: passed.
- Profile/architecture/client regression cohort: 33 tests passed.
- Local-service regression cohort: 9 tests passed (Unix socket access required).
- Installed Assistant candidate: typecheck, build, 5 tests/32 assertions and
  offline Node example passed. Real-process tests use Node 22.21.0; tooling Bun 1.4.3.
- Candidate Harness artifact version: 1.6.3 (unpublished source candidate).
- Tested tarball SHA-256:
  `368f67ddd1538470fb6c5e4c54be29da21fee77dbfe998676cee2e23d7ca04e7`.
- CLI build/help and local candidate installation without manifest/lock rewriting passed.

The artifact hash identifies that test run, not the registry artifact or future
builds. No live provider, Telegram or Calendar certification is claimed. Existing
unrelated Code/Web work was preserved. No publication, commit or merge was performed.
