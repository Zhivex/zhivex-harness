# Assistant: contracts and Harness boundary

Status: phase 0 contracts with phases 1–4 implemented, 2026-11-10.
See [persistent host and general profile](ASSISTANT_HOST.md).
Experimental v1 schemas; these are not yet a
published database format. Implementation: `packages/assistant`.

## Existing API inventory

| Public API | Intended use | Phase |
| --- | --- | --- |
| `/engine`: `createHarness`, `runHarness`, `CreateHarnessOptions` | Construction, execution, shutdown, scopes and budgets | 0 |
| `/engine`: `toolNames`, `subagentProfiles`, `projectContext`, `projectMemory` | Bound the bootstrap catalog and context | 0 |
| `/client`: `createHarnessClientAdapter` | Dispatch, review, idempotency and cancellation | 1–2 |
| `/protocol` | Client and event contracts without terminal implementation | 1–2 |
| `/service` | Authenticated local transport and recovery; no remote gateway | Evaluate in 1 |
| `/engine`: `openSessionStore` | Engine conversation index | 1 |
| `/engine`: MCP, policies and persistence | External tools and approvals | 3 |
| `/engine`: project memory | Design reference; do not automatically mix in personal memory | 4 |

The options are fields of `CreateHarnessOptions`, not separate exports.
Each API retains its tier in `contracts/engine-api.json`; this table does not stabilize
experimental APIs. Assistant does not read internal SQLite tables or import `src/`,
Code, Desktop or the Harness compatibility root export.

## Ownership and storage

Harness owns runs, checkpoints, tool receipts, approval decisions,
budgets and engine state. Assistant owns identity, connections, automation rules,
inputs, deliveries and personal preferences.

In phase 1, Assistant stores its owner/profile binding in `state/host.json`,
physically separate from the Harness store. It only links `sessionId`/`runId`; it does not duplicate checkpoints or independently decide
that an approval was accepted. There is no distributed transaction between the two
stores: use stable IDs, record intent and reconcile after restart.
Phase 2 adds `state/telegram.sqlite` for linking, session association,
inputs, deliveries and reviews. See [Telegram](ASSISTANT_TELEGRAM.md). Calendar uses its own journal; phase 4 adds preferences and occurrences to the Telegram
store. See [automations](ASSISTANT_AUTOMATIONS.md). The schemas in this
document are domain contracts; they do not literally reflect every SQLite table.

| Record | Fields and meaning |
| --- | --- |
| Owner | Local ID and explicit link to a Telegram user/private chat. Remote IDs are decimal strings. |
| Conversation | Owner, channel/chat and optional link to a Harness session. |
| Connection | Owner, Calendar account, scopes, status and opaque credential reference. Never tokens. |
| Automation | Owner, conversation, connection, calendar, local time/zone, next occurrence and enabled. |
| Delivery | Source run or automation occurrence (exactly one), conversation destination, deduplication key, attempts, text and send status. |

All carry `schemaVersion: 1`; unknown keys and unsupported versions
are rejected. Schemas validate shape, not ownership: the host and its stores verify
that conversation, connection and automation belong to the same owner.
`credentialRef` is resolved in the host, never as a path or code supplied through
messages. Validating a record does not grant account access.

## Flows and guarantees to implement

1. **Input:** unique `(channel, account, updateId)` → persist → authenticate
   owner/chat → resolve conversation → dispatch with a stable key.
   A payload does not select workspace, scope, credentials or policy.
2. **Execution:** serialize per conversation; save the task/run relationship before
   delivering results. After a crash, inspect existing state before retrying.
3. **Approval:** opaque callback token → owner/chat → engine request,
   revision, digest, expiry → resolution by Harness. Never approve based on
   model-generated text. Do not store a boolean that substitutes for its decision.
4. **Automation (phase 4 decision):** key per automation/local date
   under the owner/connection binding and Telegram lease. Recover the current
   day, skip earlier dates; do not execute a backlog. Nonexistent times
   advance to the first valid minute of that day; repeated times use their first
   occurrence. Nonexistent days are skipped. Changes recalculate future execution.
   This concrete policy replaces the phase 0 draft that skipped every missed time.
5. **Delivery:** `pending → sending → sent`; confirmed error → `failed`, timeout or
   crash after a possible send → `uncertain`. Local deduplication does not guarantee
   exactly one Telegram delivery. Do not blindly retry uncertain states.
6. **Calendar:** concrete proposal with resource version and attendee effects;
   revalidation before execution. An uncertain response requires provider-specific
   reconciliation; do not claim exactly-once if the provider cannot prove it.

Each phase guide documents stores, leases, retention, scopes and conflicts. There is no promise of
24/7 execution while the machine is off. Memory and external data do not grant permissions.

## Proposed minimal Harness extensions

- **Phase 1, implemented:** `createProfiledHarness` and `GENERAL_ASSISTANT_PROFILE`
  in `/engine`, with content and catalog fingerprinting. `createHarness` retains
  its stable signature and Code profile. Assistant consumes the local candidate;
  these exports are not yet in the published version.
- **Phase 2:** use the current protocol; extend it only if information is missing
  to represent or resolve a remote approval without losing its guarantees.
- **Phase 3:** audit MCP journals/reconciliation before designing another journal.
  Add generic states/contracts only where missing; OAuth, Google and Telegram
  never enter the engine.
- **Phase 4:** the scheduler and personal memory remain in Assistant. The deterministic
  summary uses read-only access and requires neither model context nor new
  engine contracts. Explicit preferences with provenance are not authority.

Harness was not modified in phase 0. In phase 1, the bootstrap and host use the general
profile; the stable signature snapshot was not modified to accommodate the change.

## Phase 0 acceptance

`bun run build` at the root, followed by
`bun run --cwd packages/assistant smoke:installed`, must package Harness without
rewriting its metadata, install it in a temporary consumer, check resolution
local to the consumer, validate types/schemas and execute an offline task with Node.
The report prints the tarball version and SHA-256. It does not certify a real provider,
conversation continuity, remote approvals or later phases.

### Historical phase 0 evidence — 2026-11-10

- `bun run build` (root): passed.
- `bun run architecture:check` and `bun run contract:check`: passed.
- Assistant `typecheck`, `test` and `smoke` against published dependency 1.6.3:
  passed; 3 tests, 8 assertions; offline task completed with Node 22.21.0.
- `smoke:installed`: passed against local candidate 1.6.3, resolving within
  the temporary consumer; types, tests, build and offline task completed.
- Tested candidate tarball SHA-256:
  `243962df5fae8cbb91625c79d83a7f02026ce9e3c128f07e977239b2fe6c8f4d`.
- Tooling: Bun 1.4.3. No provider calls, publication or merge.

The hash identifies the artifact from this run, not certification of the
published package or future builds. Previous Code/Web changes are outside
Assistant and were not certified by these tests.
