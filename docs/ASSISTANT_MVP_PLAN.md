# Assistant MVP by phase

Plan agreed on 2026-11-10. A sibling product to Code, built on Harness.
Goal: one user, private Telegram, Google Calendar and one machine.

> Review my schedule every morning and let me know about conflicts. If you propose
> changing a meeting, show me the change and ask for approval.

Harness controls how a task executes with guarantees. Assistant controls
who requests it, when it runs, which applications it uses and where results are delivered.
Phase 0 contracts and decisions are in [ASSISTANT_CONTRACTS.md](ASSISTANT_CONTRACTS.md).

## Phase 0 — Contracts and boundaries

**Harness:** inventory public APIs, define minimal extensions for profiles
and external effects, preserve compatibility with Code and existing state.

**Assistant:** create a standalone `@zhivex-ai/assistant`; define owner,
conversation, connection, automation and delivery; separate state using IDs.
No groups, voice, browser, marketplace or multiple users in the MVP.

**Exit criteria:** documented contracts and an example that executes a task using
an installed Harness package without internal imports. No engine changes required.

## Phase 1 — General assistant and persistent host

**Harness:** configurable instruction/tool profile; general profile
without coding; profile identity and version bound to recovery;
current default profile preserved for Code.

**Assistant:** persistent process, startup/shutdown/recovery, dedicated directory,
conversations and per-conversation serialization, configuration/logs/diagnostics.
Keep the internal workspace in this MVP.

**Exit criteria:** a test conversation recoverable after restart, with pending
approvals intact and completed actions never repeated.

## Phase 2 — Telegram and identity

**Harness:** reuse commands, events, cancellation and approvals; add only
missing generic data needed to present decisions outside the terminal.

**Assistant:** link the owner, persist/deduplicate inputs, associate chats
and sessions, reply/cancel/approve, persist deliveries and retries. Each
decision is bound to its owner, action, revision and expiry.

**Exit criteria:** duplicate inputs produce one task; repeated decisions do not
duplicate effects; other users cannot operate the assistant.

## Phase 3 — Calendar and authorization

**Harness:** evaluate existing external-effect contracts and complete
pending/confirmed/failed/uncertain states; bounded read policies;
write approvals bound to exact arguments.

**Assistant:** OAuth, protected credentials and refresh, Calendar tools,
proposals with meeting/times/attendees, provider-specific reconciliation.
Revalidate the event at execution; any relevant change invalidates the proposal.

**Exit criteria:** read the schedule and modify an approved meeting; reconcile
interruptions without blindly repeating writes. Attendee notifications are also
effects that must appear in the proposal.

## Phase 4 — Automations and personal memory

**Harness:** reuse durable execution and budgets; add a generic context interface
with provenance if missing; memory never grants permission.

**Assistant:** persistent scheduler, time zone and missed-time policy,
per-occurrence identity, persistent deliveries, frequency/usage limits.
Explicit preferences: time, calendar and conflict definition; list,
correct and forget. No semantic search or automatic consolidation initially.

**Exit criteria:** daily summary after restart, correct time zone, pause/deletion.

## Phase 5 — Validation and pilot

**Harness:** Code and contract regressions; scope isolation, cancellation,
expiry, recovery and external content with no authority over policies.

**Assistant:** complete onboarding, diagnostics, disconnection/revocation, tests
for restarts, duplicates, expired credentials and concurrently modified events.

**Exit criteria:** a multi-day pilot with message → execution → result traceability.

## Sequence and status

Conversation → channel → approved actions → proactivity. Each phase must meet its
exit criteria before enabling the next phase for users.

- Phase 0: complete; contracts, scaffold and installed-package acceptance.
  Evidence and limitations are in the contracts document.
- Phase 1: implemented; additive general profile, persistent local host and recovery
  tested with separate Node processes. See [guide and limitations](ASSISTANT_HOST.md).
- Phase 2: Telegram integration implemented and validated offline; linking,
  deduplication, deliveries and persistent approvals. See [Telegram](ASSISTANT_TELEGRAM.md).
  Validation with a real bot remains a deployment task.
- Phase 3: Calendar and OAuth implemented and validated with simulated APIs; Telegram
  approval, revalidation and persistent idempotency. See [Calendar](ASSISTANT_CALENDAR.md).
  Real-account validation is pending; no automatic migration of the previous profile.
- Phase 4: implemented; persistent daily scheduler, explicit preferences with
  provenance, time zones/DST, recovery and Telegram outbox. See [automations](ASSISTANT_AUTOMATIONS.md).
  Deterministic read-only summary; validation with simulated APIs.
- Phase 5: local validation and pilot preparation implemented; onboarding,
  offline preflight and acceptance matrix in the [pilot guide](ASSISTANT_PILOT.md).
  The multi-day pilot and real-account certification remain pending.
- This work does not authorize publication, deployment or merging into `main`.

## Post-MVP extension

Configurable OpenAI-compatible providers and composable modules are implemented
in Assistant, keeping one instance per owner. Calendar is the first
module and can be combined with MCP tools. See [contract, examples and evidence](ASSISTANT_EXTENSIONS.md).
