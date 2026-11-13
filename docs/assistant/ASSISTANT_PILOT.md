# Assistant — validation and pilot preparation

> Historical standalone-web instructions below are superseded by the
> [Tauri interface and web retirement policy](../architecture/WEB_RETIREMENT.md). CLI and
> shared embedded UI capabilities remain available as described there.

Status: unpublished local candidate. Phases 0–4 implemented. Phase 5 prepares
onboarding and validates the software locally; the multi-day pilot with
real accounts has its own acceptance criteria and **has not yet been run**.

For the first usage session, follow the [first-day test guide](../reports/ASSISTANT_WEB_HISTORY.md#first-session).

## End-to-end onboarding

Use a local machine with Node >=22.13, Bun >=1.4, network and a local browser. Choose
a short private directory (for example `$HOME/.zhx-pilot`) and a stable owner
(`local-owner`). If already using phase 3/4, keep the directory and configuration;
if coming from the profile without Calendar, use a new directory.

1. From the repository root, prepare this branch's candidate:

   ```sh
   bun run build
   bun run --cwd packages/assistant prepare:local
   bun run --cwd packages/assistant build
   ```

   Published dependency 1.6.3 does not yet include the experimental exports
   used by Assistant. `prepare:local` installs the local artifact without changing the
   manifest. Repeat preparation after reinstalling dependencies.

2. Create a dedicated polling bot, obtain its token and your own numeric ID
   through a trusted source. Set `ASSISTANT_TELEGRAM_BOT_TOKEN` in
   the environment. The bot must not have an active webhook. Do not share the token, key or
   pairing code in the repository or pilot evidence.

3. Enable Calendar API and configure a Desktop OAuth client and consent
   as described in [Calendar](ASSISTANT_CALENDAR.md). Set
   `ASSISTANT_GOOGLE_CLIENT_ID`, `ASSISTANT_GOOGLE_CLIENT_SECRET` if applicable and
   `ASSISTANT_CREDENTIAL_KEY` (32 random bytes, base64) in the environment. Keep this key
   outside the state directory and reuse it after restarts. Also configure
   credentials for the chosen model provider; for OpenAI, follow
   the [credentials guide](../providers/CREDENTIALS.md).

4. Run the offline check, replacing the example ID:

   ```sh
   bun run --cwd packages/assistant start --doctor --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789
   ```

   It must finish with `ok: true`. It validates configuration shape, Node version
   and directory, recognized provider and local provider configuration; it neither
   creates state nor queries services. It does not test remote credential validity,
   Google permissions, webhooks, remote owner identity or existing state
   compatibility. The output explicitly lists these pending checks.

5. With the host stopped, connect Google from the same machine:

   ```sh
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-connect
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-status
   ```

   Open the printed URL and consent with the intended test account. The callback
   is loopback; do not use a remote session without access to that machine's browser.
   `calendar-status` queries local state and does not certify remote token validity.

6. Start the foreground process:

   ```sh
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --calendar-id primary --telegram-owner 123456789 --web
   ```

   It must print `assistant-ready`. From the chosen account, privately send the bot
   the locally displayed `/start CODE` within ten minutes. Wait for
   the owner-linked confirmation. Another user, a group or an expired code cannot link.
   Keep the same flags when restarting. Do not run two hosts on the same
   state or two polling consumers for the same bot.
   Also open the private `assistant-web` link to test schedule,
   conversations and reviews from the browser. The link changes on restart.

7. Ask for the schedule, then a bounded change to a test event organized
   by the account. Use test attendees under pilot control: approval
   requests notifications to everyone. Verify before/after, time, calendar
   and attendees in the review; only its buttons approve/reject. Model text
   does not grant permissions. Check the result in Calendar.

8. Explicitly enable the summary from Telegram:

   ```text
   /daily 08:00 America/Argentina/Buenos_Aires
   /memory set conflictBufferMinutes 15
   /memory list
   /daily status
   ```

   Adjust time and zone for the pilot. The next time is always in the future on activation.
   Verify receipt and conflicts, then try `/daily pause`, `/daily resume`
   and `/daily delete`. DST, recovery, budget and forgetting details are in
   [automations](ASSISTANT_AUTOMATIONS.md).

## Recovery and shutdown

- Normal shutdown: SIGINT/SIGTERM (Ctrl+C), wait for `assistant-stopped`; restart
  with the same command, **without** `--recover`.
- Actual crash: verify the previous process died and restart with `--recover`.
  A live owner is rejected. Do not delete locks, `host.json` or databases to bypass
  protection. `--recover` is not normal startup: without a recoverable lock, the
  service may return ENOENT.
- Pending approval: `/pending` shows persisted state. It does not renew
  expiry; a changed or expired revision requires cancellation and a new proposal.
- Uncertain Calendar write: request reconciliation of the existing operation.
  Do not create another modification to force a resend. If reading cannot confirm it,
  inspect the event locally and stop that pilot test.
- Uncertain Telegram send: it is not resent automatically. Record uncertainty
  and check the chat before any manual intervention.
- Rejected refresh: stop the host and repeat `--calendar-connect` with the same
  account without disconnecting first; this preserves its identity. A different
  account fails closed. A wrong key requires recovering the original key,
  not replacing the state file.
- End the pilot: pause/delete the summary, stop the host and run
  `--calendar-disconnect` with directory/owner. If it returns `revoked: false`,
  complete revocation from Google. Also revoke the bot if no longer used.
  Disconnecting and reconnecting creates another identity: use a new host for it.

## Real pilot acceptance matrix

Record at least three local days, without claiming offline validation replaces
them. The operator completes one row per scenario and keeps private evidence
outside the repository:

| Scenario | Expected result | Actual status |
| --- | --- | --- |
| OAuth, linking, conversation and reading | Correct account and owner | Pending |
| Approved change and repeated callback | One change; second callback has no effect | Pending |
| Rejection/cancellation/expiry | No write | Pending |
| Event edited by another client before approval | Conflict and new approval | Pending |
| Restart with pending review | Same action/digest; no new permissions | Pending |
| Summary over three days | Correct day/zone/conflicts; one occurrence per day | Pending |
| Crash before scheduled time and recovery that day | Current day only, no backlog | Pending |
| Pause, correction and forgetting | No new pending sends or implicit activation | Pending |
| Expiry/revocation and renewed consent | Diagnostics; recovery without changing accounts | Pending |
| Pilot shutdown | Automation stopped and credentials revoked | Pending |

Stop criteria: unapproved write, wrong owner,
incorrect account/calendar, duplicate effect, secret data in outputs or
uncertainty the journal cannot explain. Stop the process and preserve
state for diagnosis. Do not delete evidence or approve repeatedly to “test”.

## Traceability and evidence

Conversation: Telegram update → inbox/intent → Harness session/run → review with
digest → Calendar operation → result → outbox/message_id. Summary:
owner command → schedule/preference revision → `daily:YYYY-MM-DD` →
outbox chunks/message_id. Delivery is independent of execution:
`enqueued` does not mean received; `uncertain` does not mean failed.

Use `/pending`, `/daily status`, `/memory list` and embedded host diagnostics.
If investigation is needed, first stop the host and inspect a private copy of
its Assistant stores; do not modify internal Harness tables. Databases contain
personal data even though OAuth tokens are encrypted. Do not attach tokens,
keys, OAuth URLs or complete databases to the shared report.

Observation template: UTC date/time and local zone; scenario; code revision
and candidate hash; updateId; runId/operationId or occurrenceId; message
IDs; expected/observed; manual intervention; final state. Use opaque
identifiers in the shared report and keep private content separate.

## Reproducible local validation

```sh
bun run typecheck
bun run typecheck:tooling
bun run architecture:check
bun run contract:check
bun run docs:check
bun run migration:check
bun run test
bun run test:code
bun run --cwd packages/assistant smoke:installed
```

Rebuild the candidate first if Harness changed. Recovery tests
use local sockets and Node processes; they need an environment that permits them.
Installed acceptance covers offline onboarding and CLI commands, simulated OAuth,
Calendar → host → Telegram → summary, hostile data without authority, approvals,
ETags, duplicates, lost responses, SIGKILL, zones/DST and preferences. Tests
do not perform real consent, demonstrate email delivery or certify
production-account configuration.

## Local evidence — 2026-11-10

| Check | Result |
| --- | --- |
| Harness + Desktop (`bun run test`) | 2376 passed, 1 platform skip, 0 failed; 14990 assertions, 292 files |
| Code (`bun run test:code`) | 170 passed, 0 failed; 2583 assertions |
| Assistant installed consumer | 42 passed, 0 failed; 226 assertions; types, build and Node example passed |
| Root and tooling types | Passed |
| Architecture and public contracts | Passed |
| Historical migrations 0.10.0/0.11.1 | Passed |
| Documentation and whitespace | Passed |

Installed candidate: unpublished Harness 1.6.3, SHA-256
`773a1929d356d5b2a72bf6a5d4b2215f425573992dd8dabee97c01228b9474b5`.
The hash identifies that tested artifact; it does not certify the registry package.
The skipped test concerns native handoff rejection on unsupported
platforms, a condition that does not apply on this machine. No failures were omitted.

Local validation includes real process restarts and SIGKILL; Google,
Telegram and model services are simulated. No deployment, publication,
merge, real consent or multi-day pilot was performed. The branch remains
`feat/assistant-phase-0`; the real acceptance matrix above remains pending.
