# Assistant — Automations and personal memory (phase 4)

One daily summary per owner, using the connected calendar. It is enabled
explicitly from the linked private chat; starting the host does not enable it.
Requires Calendar and Telegram configured as described in [Calendar](ASSISTANT_CALENDAR.md).
It needs no additional key and does not change the phase 3 profile: that directory,
account and linking can be reused. The Telegram store migration is additive.

## Telegram usage

```text
/daily 08:00 America/Argentina/Buenos_Aires
/daily status
/daily pause
/daily resume
/daily delete
```

The first command saves the time and zone, the calendar fixed by the host and an initial
conflict buffer of zero minutes. It enables the next future scheduled time. Pausing
cancels pending reads/deliveries; resuming schedules the next time without
recovering canceled runs. Deleting removes the automation while preserving
preferences and occurrence receipts to prevent duplicates if it is recreated.
A send that has already started cannot be recalled.

Explicit personal memory, limited to this automation's preferences:

```text
/memory list
/memory set conflictBufferMinutes 15
/memory set localTime 09:00
/memory set timeZone Europe/Madrid
/memory set calendarId primary
/memory forget localTime
/memory forget all
```

Each value retains provenance from the owner's authenticated message and its date.
Correcting a preference recalculates future scheduling and cancels pending work;
it does not enable a paused automation. The calendar can only be the one configured
in the host, never an account selected by a message. The buffer accepts 0–120
minutes. Forgetting removes the active preference and pauses the summary until
configuration is complete; it does not erase sent messages, inbox, conversation
history or operational receipts. There is no automatic extraction, semantic memory or free
text converted to instructions. Preferences never grant permissions.

## Scheduling, restarts and budget

- The explicit time zone is used through `Intl`, independently of the OS zone.
  A time repeated by DST executes at its first occurrence. If a time does not
  exist because of a clock jump, the first subsequent existing minute that day is used.
  An entirely nonexistent day is skipped. The read interval respects 23/25-hour days.
- The scheduler polls every 30 seconds while the host runs. It does not install an
  OS service and cannot wake a sleeping machine.
- `catch-up-today` policy: after restart, recover only the pending occurrence
  for the current local day if its scheduled time has passed. Skip earlier dates; do not build
  a backlog. A queued summary expires at the end of its day, even if the process
  restarts before the scheduler polls again.
- One occurrence per local date, with at least 20 hours between admissions. This limit
  also applies when changing zone/time or recreating the automation; a very late
  recovery can cause the next scheduled time to be skipped to prevent a burst.
- At most three read attempts, five minutes apart, with a 60-second budget
  per attempt and up to ten pages of 100 events. The counter
  persists even if reading is interrupted. An incomplete schedule produces a
  failure notice, never a summary claiming there are no conflicts.
- Up to 3660 occurrence receipts, without automatic deletion that would lose deduplication.
  Reaching the limit stops new admissions and reports a diagnostic failure.
  This deterministic summary consumes no model tokens.

## Content and security

The summary includes schedule, time zone, calendar and conflicts. It compares
busy intervals and the explicit buffer; adjacent events do not conflict with a zero buffer.
It includes all-day events and excludes canceled events,
events marked free or declined by the owner from conflict detection. It shows up to 60 events and 20
conflicting pairs, indicating the total; it analyzes all retrieved events.
It is an informational read at that moment, not a transactional Google snapshot.

Titles are data, not instructions: they are delivered as plain text without
passing through the model. The scheduler receives only the calendar-listing
capability; it cannot modify the calendar. Conversational modifications retain
phase 3 approval, revalidation and idempotency. No permissions,
tools or memory are added to the Harness profile.

## Persistence and delivery

Assistant adds `personal_preferences`, `daily_schedule`, `daily_occurrences`
and optional outbox expiry to its own `state/telegram.sqlite`. It shares
Telegram's exclusive lease and owner/bot/chat binding. The source is
also bound to the connection/calendar. It does not read internal Harness tables.

The `daily:YYYY-MM-DD` key identifies the occurrence within the fixed owner and
connection. Recording the summary in the outbox and marking it prepared is one
transaction. Restarting after that commit delivers the persisted text without another
read. If the process dies during reading, it can repeat the read within
budget; it never repeats a Calendar write. Pausing, deleting or correcting
preferences invalidates in-flight results through revision and status checks.

Deliveries use the existing Telegram queue: local deduplication, bounded retries
for retryable rejections and uncertain status if sending may have occurred.
An uncertain send is not repeated automatically. `/daily status` shows status,
next scheduled time, latest occurrences and delivery chunk counters. A
prepared summary does not imply that all its chunks arrived.

Preferences, receipts and schedule text are in the private store with local
permissions, without additional encryption; OAuth remains encrypted with the external phase 3 key.

## Validation

`tests/automation.test.ts` covers time zones and DST, current-day recovery, skipping
previous days, deduplication, pausing during reads, editing/forgetting
preferences, retry and pagination limits, conflicts and send expiry.
Integrated acceptance uses the real host and Telegram bridge with simulated APIs.
`tests/fixtures/daily-process.mjs` tests SIGKILL during a read, recovery
with another Node process, single delivery and a second restart without another read.
No real messages were sent and no account automation was enabled.

Local acceptance 2026-11-10: `smoke:installed` passed with 39 tests, 204 assertions,
0 failures, typecheck and offline Node example. Unpublished Harness candidate 1.6.3,
SHA-256 `54b1e7aaab287f3b37fa3d6194fe3b3904375956bf48507ffefdf52d5e495052`.
`architecture:check`, `contract:check`, `docs:check` and
`git diff --check` also passed. No merge or publication was performed.
