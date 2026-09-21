# HU35: update transaction coordination

`desktop/src/update-coordinator.ts` closes admission synchronously, checks global
critical work, pauses every known runtime, obtains a backup and records recovery
before closing hosts. It never requests cancellation. Work found before the
destructive boundary aborts preparation and resumes the paused hosts only through
acknowledged control operations. A failed resume or ambiguous recovery-marker
cleanup keeps desktop admission blocked.

Installation begins only after every close completes and every runtime reports
not alive. Success requires restarting the old process before any further work.
An installation failure closes remaining hosts and calls recovery before clearing
its marker. Failed recovery retains the marker and the blocked state. Error codes
do not include underlying paths, callback errors or credentials.

This is a host-side coordinator, not yet instantiated by Electron main or wired
to an update action. Its persistence and installation callbacks are contracts for
the next integration; the unit-test callbacks are not a real installer, rollback
or durable journal. The host must consult `blocked` on all admission paths,
including project changes, Git/PR operations and credential changes. Actual backup
must also reject nonterminal durable runs and leases: an idle IPC transport alone
does not prove that state can be migrated.

## Evidence

`bun test desktop/tests/update-coordinator.test.ts desktop/tests/update-service-integration.test.ts`:
**12 pass, 0 fail, 56 assertions**. Desktop TypeScript check passed.

The integration test runs an actual Harness with SQLite and an authenticated local
Unix socket, using a deterministic in-process model. It starts a real invocation,
attempts an update and proves the invocation was not cancelled or closed. The
invocation completes normally. During a second preparation, a separate socket
request is rejected for mutation while reads still work. The existing core export
creates and validates a real backup containing the completed run; deliberate
preparation failure then resumes the service and its conversation remains readable.
No native installation, provider request, Keychain access or app replacement occurs.

The other tests inject failures at pause, backup, recovery marking, close, install,
rollback and journal cleanup, plus concurrent update attempts and work arriving
during backup. These verify callback ordering and admission decisions, not the
eventual filesystem install/restore implementation.

## Backup coverage discovered

The existing `src/state-backup.ts` logical export includes runs, tool journals,
idempotency, parents, memory, sessions and session-run records. It omits
`client_activity_events` and `client_activity_snapshots`, which `src/service-events.ts`
stores in the same SQLite database. Desktop indexes and remote delivery journals
also live outside the logical export. Therefore this export alone cannot certify
complete desktop recovery. The next backup implementation must preserve these
surfaces as well, using the existing core validation where applicable.

All HU35 criteria remain open. Native publisher verification, complete backup and
durable recovery, actual installation, and main/UI integration are still required.
The previous packaged app and DMG were not rebuilt for these unconnected modules.
No push or publication; branch `feat/harness-desktop`.
